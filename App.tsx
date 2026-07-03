/**
 * Cloze Plugin
 *
 * Snapshots note pages and lets you draw opaque "cloze" boxes over them,
 * then quiz yourself by tapping boxes one at a time to reveal what's
 * underneath and grading yourself
 *
 * Cloze boxes (position + grade, keyed per page) are persisted to disk via
 * AsyncStorage under a key derived from the note's file path, so a deck
 * survives closing and reopening the plugin. Page snapshots themselves are
 * never persisted — they're cheap to regenerate on demand and can go stale
 * if the note changes. They are not written back into the note itself.
 *
 * @format
 */

import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Image,
  PanResponder,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  useColorScheme,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {Element, PluginCommAPI, PluginFileAPI, PluginManager} from 'sn-plugin-lib';

type Mode = 'edit' | 'quiz';
type Grade = 'unseen' | 'known' | 'missed';
type QuizScope = 'page' | 'all';

interface ClozeBox {
  id: string;
  // All coordinates are fractions (0..1) of the rendered page image.
  x: number;
  y: number;
  width: number;
  height: number;
  revealed: boolean;
  grade: Grade;
}

interface PageAnchor {
  // Unique marker string embedded as the content of a tiny text element we plant
  // just off-canvas past the page's bottom-right corner. It's self-labeled
  // ("CLOZE:xxxx") rather than relying on the native-assigned element uuid, so
  // it reads as an obvious, harmless plugin artifact if it's ever spotted
  // (e.g. if the off-canvas assumption turns out wrong), not a stray mark.
  token: string;
}

interface PageState {
  imageUri: string | null;
  aspectRatio: number;
  clozes: ClozeBox[];
  // Content-anchored "page ID" so clozes can be relocated if the note's pages
  // get reordered/inserted/deleted — the SDK only exposes a plain 0-based page
  // index, never a stable page ID. Null if planting the marker failed (falls
  // back to trusting the index for that page).
  anchor: PageAnchor | null;
}

interface DraftRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface QuizCard {
  page: number;
  id: string;
}

type PersistedClozeBox = Pick<ClozeBox, 'id' | 'x' | 'y' | 'width' | 'height' | 'grade'>;
interface PersistedPageEntry {
  anchor: PageAnchor | null;
  clozes: PersistedClozeBox[];
}

const MIN_BOX_PX = 14;
// Must match the sidebar button's id in index.js's PluginManager.registerButton call.
const CLOZE_BUTTON_ID = 100;
const STORAGE_PREFIX = 'clozequiz:v3:';
const ANCHOR_TOKEN_PREFIX = 'CLOZE:';
// Marker size, and how far past the page's actual pixel bounds to plant it
// (bottom-right corner, just off-canvas), in page pixels.
const ANCHOR_MARGIN = 20;
const ANCHOR_SIZE = 40;

function storageKeyForNote(notePath: string): string {
  return `${STORAGE_PREFIX}${notePath}`;
}

function newAnchorToken(): string {
  return `${ANCHOR_TOKEN_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function shuffleArray<T>(items: T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function App(): React.JSX.Element {
  const isDarkMode = useColorScheme() === 'dark';

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [totalPages, setTotalPages] = useState(1);
  const [currentPage, setCurrentPage] = useState(0);
  const [pages, setPages] = useState<Record<number, PageState>>({});

  const [mode, setMode] = useState<Mode>('edit');
  const [shuffle, setShuffle] = useState(false);
  const [anchorDebug, setAnchorDebug] = useState<string | null>(null);
  const [syncDebug, setSyncDebug] = useState<string | null>(null);
  const [draftRect, setDraftRect] = useState<DraftRect | null>(null);

  const [quizScope, setQuizScope] = useState<QuizScope>('page');
  const [quizQueue, setQuizQueue] = useState<QuizCard[]>([]);
  const [quizIndex, setQuizIndex] = useState(0);

  const notePathRef = useRef<string | null>(null);
  const pluginDirRef = useRef<string | null>(null);
  const containerSize = useRef({width: 0, height: 0});
  const startPoint = useRef({x: 0, y: 0});

  const pagesRef = useRef<Record<number, PageState>>({});
  pagesRef.current = pages;
  const currentPageRef = useRef(currentPage);
  currentPageRef.current = currentPage;
  const totalPagesRef = useRef(totalPages);
  totalPagesRef.current = totalPages;
  const syncRunCountRef = useRef(0);

  const handleClose = () => {
    PluginManager.closePluginView();
  };

  const loadPageSnapshot = useCallback(async (page: number, force = false) => {
    if (!notePathRef.current) {
      return;
    }
    if (!force && pagesRef.current[page]?.imageUri) {
      return;
    }
    try {
      const pluginDir =
        pluginDirRef.current ??
        (pluginDirRef.current = (await PluginManager.getPluginDirPath()) ?? null);
      if (!pluginDir) {
        setError('Could not access plugin storage directory.');
        return;
      }

      const pngPath = `${pluginDir}/cloze_snapshot_p${page}_${Date.now()}.png`;
      let aspectRatio = pagesRef.current[page]?.aspectRatio ?? 0.75;

      const sizeRes: any = await PluginFileAPI.getPageSize(notePathRef.current, page);
      if (sizeRes?.success && sizeRes.result?.width && sizeRes.result?.height) {
        aspectRatio = sizeRes.result.height / sizeRes.result.width;
      }

      const pngRes: any = await PluginFileAPI.generateNotePng({
        notePath: notePathRef.current,
        page,
        times: 1,
        pngPath,
        type: 1,
      });

      if (!pngRes?.success || !pngRes?.result) {
        setError(`Could not render page ${page + 1}.`);
        return;
      }

      setPages(prev => {
        const existing = prev[page] ?? {imageUri: null, aspectRatio, clozes: [], anchor: null};
        return {
          ...prev,
          [page]: {...existing, imageUri: `file://${pngPath}`, aspectRatio},
        };
      });
    } catch (e) {
      setError('Something went wrong loading the page.');
    }
  }, []);

  // Finds our marker text element on a page by its token, if one exists there.
  const findAnchorElement = useCallback(
    async (notePath: string, page: number, token: string): Promise<{num: number} | null> => {
      try {
        const res: any = await PluginFileAPI.getElements(page, notePath);
        const elements = res?.success ? res.result : null;
        if (!Array.isArray(elements)) {
          return null;
        }
        const match = elements.find(
          (el: any) => el?.type === Element.TYPE_TEXT && el?.textBox?.textContentFull === token,
        );
        if (!match) {
          return null;
        }
        return {num: match.numInPage};
      } catch (e) {
        return null;
      }
    },
    [],
  );

  // Best-effort: plant a tiny, self-labeled text marker ("CLOZE:xxxx") just past
  // the page's bottom-right corner (off-canvas — outside the page's actual pixel
  // bounds, so it shouldn't render or be reachable by lasso/select-all), and use
  // its own content as a stable "page ID". Degrades to null (index-trust only)
  // if any step fails — never throws, since this must not be able to break
  // editing/studying.
  //
  // Uses PluginCommAPI.createElement + PluginFileAPI.insertElements (the
  // officially-documented pattern — a hand-built plain object literal was
  // rejected natively) rather than PluginNoteAPI.insertText, because insertText
  // has no notePath/page params: per the docs it only affects whatever page is
  // actually on-screen in the live note, which can differ from `page` here
  // since our own Prev/Next Page buttons browse independently of the live note.
  // insertElements takes an explicit page, so this works for any page.
  const ensurePageAnchor = useCallback(
    async (notePath: string, page: number): Promise<{anchor: PageAnchor | null; debug: string}> => {
      const steps: string[] = [];
      try {
        const sizeRes: any = await PluginFileAPI.getPageSize(notePath, page);
        steps.push(
          `size:${sizeRes?.success ? `ok(${sizeRes.result?.width}x${sizeRes.result?.height})` : `fail(${sizeRes?.error?.message ?? sizeRes?.error?.code})`}`,
        );
        if (!sizeRes?.success || !sizeRes.result?.width || !sizeRes.result?.height) {
          return {anchor: null, debug: steps.join(' ')};
        }
        const left = sizeRes.result.width + ANCHOR_MARGIN;
        const top = sizeRes.result.height + ANCHOR_MARGIN;
        const token = newAnchorToken();

        const createRes: any = await PluginCommAPI.createElement(Element.TYPE_TEXT);
        steps.push(
          `create:${createRes?.success ? 'ok' : `fail(${createRes?.error?.code}:${createRes?.error?.message})`}`,
        );
        if (!createRes?.success || !createRes?.result) {
          return {anchor: null, debug: steps.join(' ')};
        }

        const element = createRes.result;
        element.layerNum = 0;
        element.textBox = {
          ...(element.textBox ?? {}),
          textContentFull: token,
          textRect: {left, top, right: left + ANCHOR_SIZE, bottom: top + ANCHOR_SIZE},
          fontSize: 8,
          textAlign: 0,
          textBold: 0,
          textItalics: 0,
          textFrameWidthType: 0,
          textFrameStyle: 0,
          textEditable: 1, // 0=editable, 1=non-editable per the docs
        };

        const insertRes: any = await PluginFileAPI.insertElements(notePath, page, [element]);
        steps.push(
          `insert:${insertRes?.success ? `ok(${insertRes.result})` : `fail(${insertRes?.error?.code}:${insertRes?.error?.message})`}`,
        );
        console.log('[ClozeQuiz] ensurePageAnchor insert response', JSON.stringify(insertRes));
        if (!insertRes?.success || !insertRes?.result) {
          return {anchor: null, debug: steps.join(' ')};
        }

        const found = await findAnchorElement(notePath, page, token);
        steps.push(`verify:${found ? 'ok' : 'not-found'}`);
        if (!found) {
          return {anchor: null, debug: steps.join(' ')};
        }
        return {anchor: {token}, debug: steps.join(' ')};
      } catch (e) {
        steps.push(`error:${(e as Error)?.message ?? String(e)}`);
        return {anchor: null, debug: steps.join(' ')};
      }
    },
    [findAnchorElement],
  );

  // Best-effort: remove the marker element once a page's deck is cleared.
  const deletePageAnchor = useCallback(async (notePath: string, page: number, anchor: PageAnchor) => {
    try {
      const found = await findAnchorElement(notePath, page, anchor.token);
      if (found) {
        await PluginFileAPI.deleteElements(notePath, page, [found.num]);
      }
    } catch (e) {
      // Nothing more we can do — worst case a stray marker lingers in the corner.
    }
  }, [findAnchorElement]);

  const restorePersistedClozes = useCallback(async (notePath: string): Promise<Record<number, PageState>> => {
    try {
      const raw = await AsyncStorage.getItem(storageKeyForNote(notePath));
      if (!raw) {
        return {};
      }
      const parsed = JSON.parse(raw) as Record<string, PersistedPageEntry>;
      const restored: Record<number, PageState> = {};
      for (const [pageStr, entry] of Object.entries(parsed)) {
        if (!entry || !Array.isArray(entry.clozes) || entry.clozes.length === 0) {
          continue;
        }
        restored[Number(pageStr)] = {
          imageUri: null,
          aspectRatio: 0.75,
          anchor: entry.anchor ?? null,
          clozes: entry.clozes.map(b => ({...b, revealed: false})),
        };
      }
      if (Object.keys(restored).length === 0) {
        return {};
      }
      // In-memory state (if any already loaded this session) wins over the restored copy.
      setPages(prev => ({...restored, ...prev}));
      return restored;
    } catch (e) {
      // Corrupt or missing storage entry — just start with an empty deck.
      return {};
    }
  }, []);

  // For every clozed page with an anchor, confirm its marker element is still at
  // that index; if not (pages reordered/inserted/deleted since), sweep the rest
  // of the note for it and relocate the clozes. Pages without an anchor (no free
  // layer slot when first clozed) are left as-is — index is all we have for them.
  const reconcilePagesByAnchor = useCallback(
    async (seed: Record<number, PageState>) => {
      const notePath = notePathRef.current;
      if (!notePath) {
        return;
      }

      const basePages: Record<number, PageState> = {...seed, ...pagesRef.current};
      const clozedEntries = Object.entries(basePages)
        .map(([p, ps]) => [Number(p), ps] as [number, PageState])
        .filter(([, ps]) => ps.clozes.length > 0);
      if (clozedEntries.length === 0) {
        return;
      }

      const needsRelocation: Array<{oldPage: number; ps: PageState}> = [];
      const confirmed = new Set<number>();

      for (const [page, ps] of clozedEntries) {
        if (!ps.anchor) {
          confirmed.add(page); // Nothing to check against — trust the index.
          continue;
        }
        if (page >= totalPagesRef.current) {
          needsRelocation.push({oldPage: page, ps});
          continue;
        }
        const found = await findAnchorElement(notePath, page, ps.anchor.token);
        if (found) {
          confirmed.add(page);
        } else {
          needsRelocation.push({oldPage: page, ps});
        }
      }

      if (needsRelocation.length === 0) {
        return;
      }

      const claimed = new Set(confirmed);
      const relocations: Array<{oldPage: number; newPage: number; ps: PageState}> = [];
      for (const entry of needsRelocation) {
        const anchor = entry.ps.anchor!;
        let found: number | null = null;
        for (let p = 0; p < totalPagesRef.current; p++) {
          if (claimed.has(p) || relocations.some(r => r.newPage === p)) {
            continue;
          }
          const match = await findAnchorElement(notePath, p, anchor.token);
          if (match) {
            found = p;
            break;
          }
        }
        if (found !== null) {
          relocations.push({oldPage: entry.oldPage, newPage: found, ps: entry.ps});
          claimed.add(found);
        }
      }

      if (relocations.length === 0) {
        return;
      }

      setPages(prev => {
        const next = {...prev};
        for (const {oldPage} of needsRelocation) {
          if (next[oldPage]) {
            next[oldPage] = {...next[oldPage], clozes: [], anchor: null};
          }
        }
        for (const {newPage, ps} of relocations) {
          const existingImage = next[newPage];
          next[newPage] = {
            imageUri: existingImage?.imageUri ?? null,
            aspectRatio: existingImage?.aspectRatio ?? ps.aspectRatio,
            clozes: ps.clozes,
            anchor: ps.anchor,
          };
        }
        return next;
      });
    },
    [findAnchorElement],
  );

  const syncCurrentPage = useCallback(async (trigger: string) => {
    setLoading(true);
    setError(null);
    const runNum = ++syncRunCountRef.current;
    const steps: string[] = [`run#${runNum}(${trigger})`];
    try {
      // The plugin host can hold a cached view of the note (e.g. page count)
      // from whenever it was first opened; structural edits made while the
      // plugin was closed/backgrounded aren't picked up until this reloads it.
      const reloadRes: any = await PluginCommAPI.reloadFile();
      steps.push(`reload:${reloadRes?.success ? `ok(${reloadRes.result})` : `fail(${reloadRes?.error?.code}:${reloadRes?.error?.message})`}`);

      const fileRes: any = await PluginCommAPI.getCurrentFilePath();
      const pageRes: any = await PluginCommAPI.getCurrentPageNum();

      const notePath = fileRes?.result;
      const page = pageRes?.result;
      steps.push(`file:${fileRes?.success ? notePath?.split('/').pop() : 'fail'}`);
      steps.push(`page:${pageRes?.success ? page : 'fail'}`);

      if (!fileRes?.success || !notePath || typeof page !== 'number') {
        setError('Open a note page to use Cloze Quiz.');
        setSyncDebug(steps.join(' '));
        setLoading(false);
        return;
      }

      notePathRef.current = notePath;
      setCurrentPage(page);

      const totalRes: any = await PluginFileAPI.getNoteTotalPageNum(notePath);
      const total =
        totalRes?.success && typeof totalRes.result === 'number' ? totalRes.result : 1;
      const totalPagesValue = Math.max(1, total);
      steps.push(`total:${totalRes?.success ? totalPagesValue : 'fail'}`);
      setSyncDebug(steps.join(' '));
      console.log('[ClozeQuiz] syncCurrentPage', steps.join(' '));
      setTotalPages(totalPagesValue);
      totalPagesRef.current = totalPagesValue;

      // Any cached page snapshot could now belong to different content — pages
      // may have been inserted/deleted/reordered in the note since we last
      // looked (e.g. the plugin's JS context surviving a close+reopen without a
      // fresh mount). Drop every cached image so revisited pages re-render from
      // scratch instead of showing stale content under the wrong index. Clozes
      // aren't touched here — reconcilePagesByAnchor below handles relocating
      // those independently via each page's own anchor marker.
      setPages(prev => {
        const next: Record<number, PageState> = {};
        for (const [pStr, ps] of Object.entries(prev)) {
          next[Number(pStr)] = {...ps, imageUri: null};
        }
        return next;
      });

      const restored = await restorePersistedClozes(notePath);
      await reconcilePagesByAnchor(restored);
      await loadPageSnapshot(page, true);
    } catch (e) {
      setError('Something went wrong loading the page.');
    } finally {
      setLoading(false);
    }
  }, [loadPageSnapshot, restorePersistedClozes, reconcilePagesByAnchor]);

  useEffect(() => {
    syncCurrentPage('mount');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The plugin's JS context/React tree appears to only ever mount once, the
  // first time the sidebar button is tapped — reopening it later just re-shows
  // the same instance rather than remounting, so the effect above never fires
  // again and note edits made while "closed" are never picked up automatically.
  // `onStart`/`onStop` plugin-life events didn't reliably fire on re-open either
  // (confirmed via the run# counter in syncDebug staying frozen across
  // close/reopen cycles). The one signal that's guaranteed to fire every time
  // the user (re)opens this plugin is the sidebar button press itself.
  useEffect(() => {
    const sub = PluginManager.registerButtonListener({
      onButtonPress: (event: any) => {
        if (event?.id === CLOZE_BUTTON_ID) {
          syncCurrentPage('button-press');
        }
      },
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist cloze positions + grades (not images, not `revealed`) whenever they change.
  useEffect(() => {
    const notePath = notePathRef.current;
    if (!notePath) {
      return;
    }
    const toSave: Record<number, PersistedPageEntry> = {};
    for (const [pageStr, ps] of Object.entries(pages)) {
      if (ps.clozes.length === 0) {
        continue;
      }
      toSave[Number(pageStr)] = {
        anchor: ps.anchor,
        clozes: ps.clozes.map(({id, x, y, width, height, grade}) => ({
          id,
          x,
          y,
          width,
          height,
          grade,
        })),
      };
    }
    AsyncStorage.setItem(storageKeyForNote(notePath), JSON.stringify(toSave)).catch(() => {});
  }, [pages]);

  const goToPage = (delta: number) => {
    const next = Math.min(Math.max(currentPage + delta, 0), totalPages - 1);
    if (next === currentPage) {
      return;
    }
    setCurrentPage(next);
    if (!pagesRef.current[next]?.imageUri) {
      loadPageSnapshot(next);
    }
  };

  const isInsideAnyBox = (x: number, y: number) => {
    const {width, height} = containerSize.current;
    if (!width || !height) {
      return false;
    }
    const clozes = pagesRef.current[currentPageRef.current]?.clozes ?? [];
    return clozes.some(box => {
      const bx = box.x * width;
      const by = box.y * height;
      const bw = box.width * width;
      const bh = box.height * height;
      return x >= bx && x <= bx + bw && y >= by && y <= by + bh;
    });
  };

  // Recreated only when mode changes; reads current page/cloze data through
  // refs at call time so it never acts on stale state (see prior bug where
  // this was built once via useRef and froze `mode` at its initial value).
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: evt => {
          if (mode !== 'edit') {
            return false;
          }
          const {locationX, locationY} = evt.nativeEvent;
          return !isInsideAnyBox(locationX, locationY);
        },
        onMoveShouldSetPanResponder: () => mode === 'edit',
        onPanResponderGrant: evt => {
          const {locationX, locationY} = evt.nativeEvent;
          startPoint.current = {x: locationX, y: locationY};
          setDraftRect({x: locationX, y: locationY, width: 0, height: 0});
        },
        onPanResponderMove: (_evt, gestureState) => {
          const sx = startPoint.current.x;
          const sy = startPoint.current.y;
          const curX = sx + gestureState.dx;
          const curY = sy + gestureState.dy;
          setDraftRect({
            x: Math.min(sx, curX),
            y: Math.min(sy, curY),
            width: Math.abs(gestureState.dx),
            height: Math.abs(gestureState.dy),
          });
        },
        onPanResponderRelease: () => {
          setDraftRect(prev => {
            const {width, height} = containerSize.current;
            if (
              prev &&
              width > 0 &&
              height > 0 &&
              prev.width > MIN_BOX_PX &&
              prev.height > MIN_BOX_PX
            ) {
              const box: ClozeBox = {
                id: `c${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
                x: prev.x / width,
                y: prev.y / height,
                width: prev.width / width,
                height: prev.height / height,
                revealed: false,
                grade: 'unseen',
              };
              const page = currentPageRef.current;
              let hadAnchor = false;
              setPages(prevPages => {
                const existing = prevPages[page] ?? {
                  imageUri: null,
                  aspectRatio: 0.75,
                  clozes: [],
                  anchor: null,
                };
                hadAnchor = !!existing.anchor;
                return {
                  ...prevPages,
                  [page]: {...existing, clozes: [...existing.clozes, box]},
                };
              });
              // First cloze on this page this session — try to plant a page anchor
              // so it can survive reordering. Fire-and-forget; degrades silently.
              if (!hadAnchor && notePathRef.current) {
                const notePath = notePathRef.current;
                ensurePageAnchor(notePath, page).then(({anchor, debug}) => {
                  setAnchorDebug(`p${page}: ${debug}`);
                  if (!anchor) {
                    return;
                  }
                  setPages(prevPages => {
                    const existing = prevPages[page];
                    if (!existing || existing.anchor) {
                      return prevPages;
                    }
                    return {...prevPages, [page]: {...existing, anchor}};
                  });
                });
              }
            }
            return null;
          });
        },
      }),
    [mode, ensurePageAnchor],
  );

  const removeCloze = (id: string) => {
    const page = currentPage;
    let clearedAnchor: PageAnchor | null = null;
    setPages(prev => {
      const existing = prev[page];
      if (!existing) {
        return prev;
      }
      const clozes = existing.clozes.filter(c => c.id !== id);
      const anchorCleared = clozes.length === 0 ? null : existing.anchor;
      if (clozes.length === 0 && existing.anchor) {
        clearedAnchor = existing.anchor;
      }
      return {...prev, [page]: {...existing, clozes, anchor: anchorCleared}};
    });
    if (clearedAnchor && notePathRef.current) {
      deletePageAnchor(notePathRef.current, page, clearedAnchor);
    }
  };

  const clearCurrentPageClozes = () => {
    const page = currentPage;
    const anchor = pagesRef.current[page]?.anchor ?? null;
    setPages(prev => {
      const existing = prev[page];
      if (!existing) {
        return prev;
      }
      return {...prev, [page]: {...existing, clozes: [], anchor: null}};
    });
    if (anchor && notePathRef.current) {
      deletePageAnchor(notePathRef.current, page, anchor);
    }
  };

  const buildQueue = (scope: QuizScope): {order: number[]; cards: QuizCard[]} => {
    const order =
      scope === 'all'
        ? Object.keys(pagesRef.current)
            .map(Number)
            .sort((a, b) => a - b)
        : [currentPageRef.current];
    let cards: QuizCard[] = [];
    for (const p of order) {
      const clozes = pagesRef.current[p]?.clozes ?? [];
      for (const c of clozes) {
        cards.push({page: p, id: c.id});
      }
    }
    if (shuffle) {
      cards = shuffleArray(cards);
    }
    return {order, cards};
  };

  const startQuiz = (scope: QuizScope) => {
    const {order, cards} = buildQueue(scope);
    if (cards.length === 0) {
      return;
    }
    setPages(prev => {
      const next = {...prev};
      for (const p of order) {
        if (!next[p]) {
          continue;
        }
        next[p] = {
          ...next[p],
          clozes: next[p].clozes.map(c => ({...c, revealed: false, grade: 'unseen' as Grade})),
        };
      }
      return next;
    });
    setQuizScope(scope);
    setQuizQueue(cards);
    setQuizIndex(0);
    setMode('quiz');
  };

  const restartQuiz = () => startQuiz(quizScope);

  const resetCurrentQueue = () => {
    setPages(prev => {
      const next = {...prev};
      const idsByPage = new Map<number, Set<string>>();
      for (const card of quizQueue) {
        if (!idsByPage.has(card.page)) {
          idsByPage.set(card.page, new Set());
        }
        idsByPage.get(card.page)!.add(card.id);
      }
      for (const [p, ids] of idsByPage) {
        if (!next[p]) {
          continue;
        }
        next[p] = {
          ...next[p],
          clozes: next[p].clozes.map(c =>
            ids.has(c.id) ? {...c, revealed: false, grade: 'unseen' as Grade} : c,
          ),
        };
      }
      return next;
    });
    setQuizIndex(0);
  };

  // Keep the visible page in sync with whichever card the quiz is on, and
  // lazily render a snapshot if that page hasn't been visited yet.
  useEffect(() => {
    if (mode !== 'quiz') {
      return;
    }
    const card = quizQueue[quizIndex];
    if (!card) {
      return;
    }
    if (card.page !== currentPageRef.current) {
      setCurrentPage(card.page);
    }
    if (!pagesRef.current[card.page]?.imageUri) {
      loadPageSnapshot(card.page);
    }
  }, [mode, quizIndex, quizQueue, loadPageSnapshot]);

  const revealCurrentCard = () => {
    const card = quizQueue[quizIndex];
    if (!card) {
      return;
    }
    setPages(prev => {
      const pg = prev[card.page];
      if (!pg) {
        return prev;
      }
      return {
        ...prev,
        [card.page]: {
          ...pg,
          clozes: pg.clozes.map(c => (c.id === card.id ? {...c, revealed: !c.revealed} : c)),
        },
      };
    });
  };

  const gradeCurrentCard = (grade: 'known' | 'missed') => {
    const card = quizQueue[quizIndex];
    if (!card) {
      return;
    }
    setPages(prev => {
      const pg = prev[card.page];
      if (!pg) {
        return prev;
      }
      return {
        ...prev,
        [card.page]: {
          ...pg,
          clozes: pg.clozes.map(c => (c.id === card.id ? {...c, revealed: true, grade} : c)),
        },
      };
    });
    setQuizIndex(i => Math.min(i + 1, quizQueue.length));
  };

  const goPrevCard = () => setQuizIndex(i => Math.max(i - 1, 0));
  const goNextCard = () => setQuizIndex(i => Math.min(i + 1, quizQueue.length));

  const currentPageState = pages[currentPage];
  const currentPageClozeCount = currentPageState?.clozes.length ?? 0;
  const totalClozesAllPages = useMemo(
    () => Object.values(pages).reduce((sum, ps) => sum + ps.clozes.length, 0),
    [pages],
  );
  const otherPagesHaveClozes = useMemo(
    () =>
      Object.entries(pages).some(
        ([p, ps]) => Number(p) !== currentPage && ps.clozes.length > 0,
      ),
    [pages, currentPage],
  );

  const atSummary = mode === 'quiz' && quizIndex >= quizQueue.length;
  const currentCard = mode === 'quiz' && !atSummary ? quizQueue[quizIndex] : undefined;
  const currentCardBox =
    currentCard && currentPageState
      ? currentPageState.clozes.find(c => c.id === currentCard.id)
      : undefined;

  const quizStats = useMemo(() => {
    let known = 0;
    let missed = 0;
    for (const card of quizQueue) {
      const c = pages[card.page]?.clozes.find(x => x.id === card.id);
      if (c?.grade === 'known') {
        known++;
      } else if (c?.grade === 'missed') {
        missed++;
      }
    }
    return {known, missed, total: quizQueue.length};
  }, [quizQueue, pages]);

  const textColor = isDarkMode ? '#ffffff' : '#000000';
  const bg = isDarkMode ? '#000000' : '#ffffff';

  const title =
    mode === 'quiz'
      ? atSummary
        ? 'Quiz Me · Done'
        : `Quiz Me · Card ${quizIndex + 1}/${quizQueue.length}`
      : `Cloze Quiz${totalPages > 1 ? ` · Page ${currentPage + 1}/${totalPages}` : ''}`;

  return (
    <View style={[styles.container, {backgroundColor: bg}]}>
      <StatusBar
        barStyle={isDarkMode ? 'light-content' : 'dark-content'}
        backgroundColor={bg}
      />

      <View style={styles.topBar}>
        <Pressable style={styles.iconButton} onPress={handleClose}>
          <Text style={[styles.iconText, {color: textColor}]}>✕</Text>
        </Pressable>

        <Text style={[styles.title, {color: textColor}]} numberOfLines={1}>
          {title}
        </Text>

        <View style={styles.topBarActions}>
          {mode === 'edit' ? (
            <>
              <TouchableOpacity
                style={styles.pillButton}
                onPress={clearCurrentPageClozes}
                disabled={currentPageClozeCount === 0}>
                <Text
                  style={[
                    styles.pillButtonText,
                    currentPageClozeCount === 0 && styles.pillButtonTextDisabled,
                  ]}>
                  Clear
                </Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.pillButton} onPress={() => setShuffle(s => !s)}>
                <Text style={styles.pillButtonText}>Shuffle: {shuffle ? 'On' : 'Off'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.pillButton} onPress={() => syncCurrentPage('refresh-button')}>
                <Text style={styles.pillButtonText}>Refresh</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              {!atSummary && (
                <TouchableOpacity style={styles.pillButton} onPress={resetCurrentQueue}>
                  <Text style={styles.pillButtonText}>Reset</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity style={styles.pillButton} onPress={() => setMode('edit')}>
                <Text style={styles.pillButtonText}>Exit Quiz</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>

      {mode === 'edit' && totalPages > 1 && !loading && !error && (
        <View style={styles.pageNavRow}>
          <TouchableOpacity
            style={styles.pageNavButton}
            onPress={() => goToPage(-1)}
            disabled={currentPage === 0}>
            <Text
              style={[
                styles.pageNavButtonText,
                currentPage === 0 && styles.pillButtonTextDisabled,
              ]}>
              ‹ Prev Page
            </Text>
          </TouchableOpacity>
          <Text style={[styles.pageNavText, {color: textColor}]}>
            Page {currentPage + 1} / {totalPages}
          </Text>
          <TouchableOpacity
            style={styles.pageNavButton}
            onPress={() => goToPage(1)}
            disabled={currentPage === totalPages - 1}>
            <Text
              style={[
                styles.pageNavButtonText,
                currentPage === totalPages - 1 && styles.pillButtonTextDisabled,
              ]}>
              Next Page ›
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {mode === 'edit' && syncDebug && (
        <Text style={styles.debugText} numberOfLines={2}>
          {syncDebug}
        </Text>
      )}

      {mode === 'edit' && anchorDebug && (
        <Text style={styles.debugText} numberOfLines={2}>
          {anchorDebug}
        </Text>
      )}

      {loading && (
        <View style={styles.centerFill}>
          <ActivityIndicator size="large" color={textColor} />
        </View>
      )}

      {!loading && error && (
        <View style={styles.centerFill}>
          <Text style={[styles.errorText, {color: textColor}]}>{error}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={() => syncCurrentPage('retry-button')}>
            <Text style={styles.retryButtonText}>Try Again</Text>
          </TouchableOpacity>
        </View>
      )}

      {!loading && !error && atSummary && (
        <View style={styles.centerFill}>
          <Text style={[styles.summaryTitle, {color: textColor}]}>Quiz complete</Text>
          <Text style={[styles.summaryScore, {color: textColor}]}>
            Got it: {quizStats.known} · Missed: {quizStats.missed} · Total: {quizStats.total}
          </Text>
        </View>
      )}

      {!loading && !error && !atSummary && currentPageState?.imageUri && (
        <View style={styles.pageArea}>
          <View
            style={[styles.pageFrame, {aspectRatio: 1 / (currentPageState.aspectRatio || 0.75)}]}
            onLayout={e => {
              containerSize.current = {
                width: e.nativeEvent.layout.width,
                height: e.nativeEvent.layout.height,
              };
            }}
            {...panResponder.panHandlers}>
            <Image
              source={{uri: currentPageState.imageUri}}
              style={StyleSheet.absoluteFill}
              resizeMode="contain"
            />

            {currentPageState.clozes.map(box => {
              const style = {
                left: `${box.x * 100}%` as const,
                top: `${box.y * 100}%` as const,
                width: `${box.width * 100}%` as const,
                height: `${box.height * 100}%` as const,
              };

              if (mode === 'edit') {
                return (
                  <View key={box.id} style={[styles.editBox, style]}>
                    <TouchableOpacity
                      style={styles.deleteChip}
                      onPress={() => removeCloze(box.id)}
                      hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                      <Text style={styles.deleteChipText}>✕</Text>
                    </TouchableOpacity>
                  </View>
                );
              }

              // Quiz mode.
              const isCurrent = currentCard?.id === box.id;

              if (box.grade === 'known' || box.grade === 'missed') {
                return (
                  <View key={box.id} style={[styles.revealedBox, style]}>
                    <View style={styles.gradeChip}>
                      <Text style={styles.gradeChipText}>
                        {box.grade === 'known' ? '✓' : '✕'}
                      </Text>
                    </View>
                  </View>
                );
              }

              if (box.revealed) {
                // Peeked but not graded yet — only the current card can be in this state.
                return (
                  <TouchableOpacity
                    key={box.id}
                    style={[styles.revealedBox, style]}
                    onPress={revealCurrentCard}
                  />
                );
              }

              if (isCurrent) {
                return (
                  <TouchableOpacity
                    key={box.id}
                    style={[styles.hiddenBox, styles.focusedHiddenBox, style]}
                    onPress={revealCurrentCard}
                    activeOpacity={0.85}>
                    <Text style={styles.hiddenBoxText}>?</Text>
                  </TouchableOpacity>
                );
              }

              return <View key={box.id} pointerEvents="none" style={[styles.hiddenBox, style]} />;
            })}

            {mode === 'edit' && draftRect && (
              <View
                pointerEvents="none"
                style={[
                  styles.editBox,
                  {
                    left: draftRect.x,
                    top: draftRect.y,
                    width: draftRect.width,
                    height: draftRect.height,
                  },
                ]}
              />
            )}
          </View>
        </View>
      )}

      {!loading && !error && (
        <View style={styles.bottomBar}>
          {mode === 'edit' ? (
            <>
              <TouchableOpacity style={[styles.modeButton, styles.modeButtonActive]}>
                <Text style={[styles.modeButtonText, styles.modeButtonTextActive]}>
                  Edit Clozes
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modeButton}
                onPress={() => startQuiz('page')}
                disabled={currentPageClozeCount === 0}>
                <Text
                  style={[
                    styles.modeButtonText,
                    currentPageClozeCount === 0 && styles.modeButtonTextDisabled,
                  ]}>
                  Quiz Me{currentPageClozeCount > 0 ? ` (${currentPageClozeCount})` : ''}
                </Text>
              </TouchableOpacity>
              {otherPagesHaveClozes && (
                <TouchableOpacity style={styles.modeButton} onPress={() => startQuiz('all')}>
                  <Text style={styles.modeButtonText}>
                    Quiz All Pages ({totalClozesAllPages})
                  </Text>
                </TouchableOpacity>
              )}
            </>
          ) : atSummary ? (
            <>
              <TouchableOpacity style={styles.modeButton} onPress={restartQuiz}>
                <Text style={styles.modeButtonText}>Restart</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modeButton} onPress={() => setMode('edit')}>
                <Text style={styles.modeButtonText}>Back to Edit</Text>
              </TouchableOpacity>
            </>
          ) : (
            <View style={styles.quizControls}>
              <View style={styles.quizStatsRow}>
                <Text style={[styles.quizStatsText, {color: textColor}]}>
                  ✓ {quizStats.known} · ✕ {quizStats.missed} · left{' '}
                  {quizStats.total - quizStats.known - quizStats.missed}
                </Text>
              </View>
              <View style={styles.quizButtonsRow}>
                <TouchableOpacity
                  style={styles.modeButton}
                  onPress={goPrevCard}
                  disabled={quizIndex === 0}>
                  <Text
                    style={[
                      styles.modeButtonText,
                      quizIndex === 0 && styles.modeButtonTextDisabled,
                    ]}>
                    ‹ Prev
                  </Text>
                </TouchableOpacity>

                {currentCardBox?.revealed ? (
                  <>
                    <TouchableOpacity
                      style={styles.modeButton}
                      onPress={() => gradeCurrentCard('missed')}>
                      <Text style={styles.modeButtonText}>Missed it</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.modeButton}
                      onPress={() => gradeCurrentCard('known')}>
                      <Text style={styles.modeButtonText}>Got it</Text>
                    </TouchableOpacity>
                  </>
                ) : (
                  <>
                    <TouchableOpacity style={styles.modeButton} onPress={revealCurrentCard}>
                      <Text style={styles.modeButtonText}>Reveal</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.modeButton} onPress={goNextCard}>
                      <Text style={styles.modeButtonText}>Skip ›</Text>
                    </TouchableOpacity>
                  </>
                )}
              </View>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingTop: 12,
    paddingBottom: 8,
  },
  iconButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
  },
  iconText: {
    fontSize: 18,
    fontWeight: '600',
  },
  title: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    marginHorizontal: 8,
  },
  topBarActions: {
    flexDirection: 'row',
  },
  pillButton: {
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 5,
    marginLeft: 6,
  },
  pillButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#000000',
  },
  pillButtonTextDisabled: {
    color: '#aaaaaa',
  },
  pageNavRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 8,
  },
  pageNavButton: {
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  pageNavButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#000000',
  },
  pageNavText: {
    fontSize: 13,
    fontWeight: '600',
    marginHorizontal: 10,
  },
  debugText: {
    fontSize: 10,
    color: '#888888',
    paddingHorizontal: 12,
    paddingBottom: 6,
  },
  centerFill: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  errorText: {
    fontSize: 15,
    textAlign: 'center',
    marginBottom: 16,
  },
  retryButton: {
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  retryButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  summaryTitle: {
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 12,
  },
  summaryScore: {
    fontSize: 15,
    textAlign: 'center',
  },
  pageArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  pageFrame: {
    width: '100%',
    maxHeight: '100%',
    backgroundColor: '#ffffff',
  },
  editBox: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: '#000000',
    borderStyle: 'dashed',
    backgroundColor: 'rgba(255,255,255,0.4)',
  },
  deleteChip: {
    position: 'absolute',
    top: -12,
    right: -12,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteChipText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
  },
  hiddenBox: {
    position: 'absolute',
    backgroundColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  focusedHiddenBox: {
    borderWidth: 3,
    borderColor: '#ffffff',
  },
  hiddenBoxText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
  },
  revealedBox: {
    position: 'absolute',
    borderWidth: 1,
    borderColor: '#000000',
    borderStyle: 'dashed',
  },
  gradeChip: {
    position: 'absolute',
    top: -10,
    left: -10,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  gradeChipText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '700',
  },
  bottomBar: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  modeButton: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: '#000000',
    marginHorizontal: 4,
    borderRadius: 18,
  },
  modeButtonActive: {
    backgroundColor: '#000000',
  },
  modeButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#000000',
  },
  modeButtonTextActive: {
    color: '#ffffff',
  },
  modeButtonTextDisabled: {
    color: '#aaaaaa',
  },
  quizControls: {
    flex: 1,
  },
  quizStatsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginBottom: 8,
  },
  quizStatsText: {
    fontSize: 13,
    fontWeight: '600',
  },
  quizButtonsRow: {
    flexDirection: 'row',
  },
});

export default App;
