/**
 * Cloze Plugin
 *
 * Snapshots note pages and lets you draw opaque "cloze" boxes over them,
 * organized into named decks, then quiz yourself by tapping boxes one at a
 * time to reveal what's underneath and grading yourself.
 *
 * Cloze boxes (position + grade + deck, keyed per page) and the note's deck
 * list are persisted to disk via AsyncStorage under a key derived from the
 * note's file path, so a deck survives closing and reopening the plugin.
 * Page snapshots themselves are never persisted — they're cheap to
 * regenerate on demand and can go stale if the note changes. They are not
 * written back into the note itself (aside from a tiny off-canvas per-page
 * marker used purely to track pages across reorder/insert/delete).
 *
 * @format
 */

import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  PanResponder,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useColorScheme,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  Element,
  PluginCommAPI,
  PluginFileAPI,
  PluginManager,
} from 'sn-plugin-lib';

type Mode = 'edit' | 'quiz';
type Grade = 'unseen' | 'known' | 'missed';
type Screen = 'editor' | 'library' | 'decks' | 'quizPicker';

interface NoteSummary {
  notePath: string;
  pageCount: number;
  clozeCount: number;
}

interface Deck {
  id: string;
  name: string;
}

interface ClozeBox {
  id: string;
  // All coordinates are fractions (0..1) of the rendered page image.
  x: number;
  y: number;
  width: number;
  height: number;
  revealed: boolean;
  grade: Grade;
  deckId: string;
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

type PersistedClozeBox = Pick<
  ClozeBox,
  'id' | 'x' | 'y' | 'width' | 'height' | 'grade' | 'deckId'
>;
interface PersistedPageEntry {
  anchor: PageAnchor | null;
  clozes: PersistedClozeBox[];
}
interface PersistedNoteData {
  decks: Deck[];
  pages: Record<number, PersistedPageEntry>;
}

const MIN_BOX_PX = 14;
// Must match the sidebar button's id in index.js's PluginManager.registerButton call.
const CLOZE_BUTTON_ID = 100;
const STORAGE_PREFIX = 'clozequiz:v4:';
const ANCHOR_TOKEN_PREFIX = 'CLOZE:';
// Marker size, and how far past the page's actual pixel bounds to plant it
// (bottom-right corner, just off-canvas), in page pixels.
const ANCHOR_MARGIN = 20;
const ANCHOR_SIZE = 40;
const DEFAULT_DECK_ID = 'default';
const DEFAULT_DECK_NAME = 'Default';
const DEFAULT_DECKS: Deck[] = [{id: DEFAULT_DECK_ID, name: DEFAULT_DECK_NAME}];

function storageKeyForNote(notePath: string): string {
  return `${STORAGE_PREFIX}${notePath}`;
}

function newAnchorToken(): string {
  return `${ANCHOR_TOKEN_PREFIX}${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function newDeckId(): string {
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
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
  const [draftRect, setDraftRect] = useState<DraftRect | null>(null);

  const [quizQueue, setQuizQueue] = useState<QuizCard[]>([]);
  const [quizIndex, setQuizIndex] = useState(0);
  const [activeQuizDeckIds, setActiveQuizDeckIds] = useState<string[]>([]);

  const [decks, setDecks] = useState<Deck[]>(DEFAULT_DECKS);
  const [activeDeckId, setActiveDeckId] = useState<string>(DEFAULT_DECK_ID);

  const [screen, setScreen] = useState<Screen>('editor');
  const [library, setLibrary] = useState<NoteSummary[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);

  const [newDeckName, setNewDeckName] = useState('');
  const [renamingDeckId, setRenamingDeckId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [quizPickerSelection, setQuizPickerSelection] = useState<Set<string>>(
    new Set(),
  );

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
  const decksRef = useRef<Deck[]>(decks);
  decksRef.current = decks;
  const activeDeckIdRef = useRef(activeDeckId);
  activeDeckIdRef.current = activeDeckId;

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
        (pluginDirRef.current =
          (await PluginManager.getPluginDirPath()) ?? null);
      if (!pluginDir) {
        setError('Could not access plugin storage directory.');
        return;
      }

      const pngPath = `${pluginDir}/cloze_snapshot_p${page}_${Date.now()}.png`;
      let aspectRatio = pagesRef.current[page]?.aspectRatio ?? 0.75;

      const sizeRes: any = await PluginFileAPI.getPageSize(
        notePathRef.current,
        page,
      );
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
        const existing = prev[page] ?? {
          imageUri: null,
          aspectRatio,
          clozes: [],
          anchor: null,
        };
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
    async (
      notePath: string,
      page: number,
      token: string,
    ): Promise<{num: number} | null> => {
      try {
        const res: any = await PluginFileAPI.getElements(page, notePath);
        const elements = res?.success ? res.result : null;
        if (!Array.isArray(elements)) {
          return null;
        }
        const match = elements.find(
          (el: any) =>
            el?.type === Element.TYPE_TEXT &&
            el?.textBox?.textContentFull === token,
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
    async (notePath: string, page: number): Promise<PageAnchor | null> => {
      try {
        const sizeRes: any = await PluginFileAPI.getPageSize(notePath, page);
        if (
          !sizeRes?.success ||
          !sizeRes.result?.width ||
          !sizeRes.result?.height
        ) {
          return null;
        }
        const left = sizeRes.result.width + ANCHOR_MARGIN;
        const top = sizeRes.result.height + ANCHOR_MARGIN;
        const token = newAnchorToken();

        const createRes: any = await PluginCommAPI.createElement(
          Element.TYPE_TEXT,
        );
        if (!createRes?.success || !createRes?.result) {
          return null;
        }

        const element = createRes.result;
        element.layerNum = 0;
        element.textBox = {
          ...(element.textBox ?? {}),
          textContentFull: token,
          textRect: {
            left,
            top,
            right: left + ANCHOR_SIZE,
            bottom: top + ANCHOR_SIZE,
          },
          fontSize: 8,
          textAlign: 0,
          textBold: 0,
          textItalics: 0,
          textFrameWidthType: 0,
          textFrameStyle: 0,
          textEditable: 1, // 0=editable, 1=non-editable per the docs
        };

        const insertRes: any = await PluginFileAPI.insertElements(
          notePath,
          page,
          [element],
        );
        if (!insertRes?.success || !insertRes?.result) {
          return null;
        }

        const found = await findAnchorElement(notePath, page, token);
        return found ? {token} : null;
      } catch (e) {
        return null;
      }
    },
    [findAnchorElement],
  );

  // Best-effort: remove the marker element once a page's clozes are cleared.
  const deletePageAnchor = useCallback(
    async (notePath: string, page: number, anchor: PageAnchor) => {
      try {
        const found = await findAnchorElement(notePath, page, anchor.token);
        if (found) {
          await PluginFileAPI.deleteElements(notePath, page, [found.num]);
        }
      } catch (e) {
        // Nothing more we can do — worst case a stray marker lingers in the corner.
      }
    },
    [findAnchorElement],
  );

  // Scans every note with saved cloze data (not just the currently open one)
  // for the library screen.
  const loadLibrary = useCallback(async () => {
    setLibraryLoading(true);
    try {
      const keys = await AsyncStorage.getAllKeys();
      const clozeKeys = keys.filter(k => k.startsWith(STORAGE_PREFIX));
      const entries = await AsyncStorage.multiGet(clozeKeys);
      const summaries: NoteSummary[] = [];
      for (const [key, raw] of entries) {
        if (!raw) {
          continue;
        }
        try {
          const parsed = JSON.parse(raw) as PersistedNoteData;
          let pageCount = 0;
          let clozeCount = 0;
          for (const entry of Object.values(parsed.pages ?? {})) {
            if (entry?.clozes?.length) {
              pageCount++;
              clozeCount += entry.clozes.length;
            }
          }
          if (pageCount > 0) {
            summaries.push({
              notePath: key.slice(STORAGE_PREFIX.length),
              pageCount,
              clozeCount,
            });
          }
        } catch (e) {
          // Corrupt entry for this note — skip it rather than fail the whole list.
        }
      }
      summaries.sort((a, b) => a.notePath.localeCompare(b.notePath));
      setLibrary(summaries);
    } catch (e) {
      setLibrary([]);
    } finally {
      setLibraryLoading(false);
    }
  }, []);

  // Removes ALL of a note's saved data (every deck): best-effort cleanup of
  // each page's off-canvas marker element (works for any note, not just the
  // currently open one — the underlying APIs take an explicit notePath/page),
  // then drops the storage entry. If it's the note currently open in the
  // editor, resets live state too so the persist-on-change effect doesn't
  // immediately write the data back.
  const deleteNoteData = useCallback(
    async (notePath: string) => {
      const key = storageKeyForNote(notePath);
      try {
        const raw = await AsyncStorage.getItem(key);
        if (raw) {
          const parsed = JSON.parse(raw) as PersistedNoteData;
          for (const [pageStr, entry] of Object.entries(parsed.pages ?? {})) {
            if (entry?.anchor) {
              await deletePageAnchor(notePath, Number(pageStr), entry.anchor);
            }
          }
        }
      } catch (e) {
        // Best effort — still remove the storage entry below regardless.
      }
      await AsyncStorage.removeItem(key);
      if (notePath === notePathRef.current) {
        setPages({});
        setDecks(DEFAULT_DECKS);
        setActiveDeckId(DEFAULT_DECK_ID);
      }
      setLibrary(prev => prev.filter(n => n.notePath !== notePath));
    },
    [deletePageAnchor],
  );

  const confirmDeleteNoteData = useCallback(
    (note: NoteSummary) => {
      Alert.alert(
        'Delete all cloze data?',
        `Remove ${note.clozeCount} cloze${
          note.clozeCount === 1 ? '' : 's'
        } across ${note.pageCount} page${
          note.pageCount === 1 ? '' : 's'
        } (all decks) for "${note.notePath
          .split('/')
          .pop()}"? This can't be undone.`,
        [
          {text: 'Cancel', style: 'cancel'},
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => deleteNoteData(note.notePath),
          },
        ],
      );
    },
    [deleteNoteData],
  );

  const restorePersistedClozes = useCallback(
    async (notePath: string): Promise<Record<number, PageState>> => {
      try {
        const raw = await AsyncStorage.getItem(storageKeyForNote(notePath));
        if (!raw) {
          setDecks(DEFAULT_DECKS);
          setActiveDeckId(DEFAULT_DECK_ID);
          return {};
        }
        const parsed = JSON.parse(raw) as PersistedNoteData;
        const restoredDecks =
          Array.isArray(parsed.decks) && parsed.decks.length > 0
            ? parsed.decks
            : DEFAULT_DECKS;
        setDecks(restoredDecks);
        // Only reset the active deck if the current selection doesn't exist in
        // this note's deck list (e.g. this is a genuinely different note, or
        // first load) — otherwise a resync (Refresh, reopening the plugin,
        // etc.) would silently revert whichever deck the user had switched to.
        setActiveDeckId(prev =>
          restoredDecks.some(d => d.id === prev) ? prev : restoredDecks[0].id,
        );

        const restored: Record<number, PageState> = {};
        for (const [pageStr, entry] of Object.entries(parsed.pages ?? {})) {
          if (
            !entry ||
            !Array.isArray(entry.clozes) ||
            entry.clozes.length === 0
          ) {
            continue;
          }
          restored[Number(pageStr)] = {
            imageUri: null,
            aspectRatio: 0.75,
            anchor: entry.anchor ?? null,
            clozes: entry.clozes.map(b => ({
              ...b,
              deckId: b.deckId ?? DEFAULT_DECK_ID,
              revealed: false,
            })),
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
        setDecks(DEFAULT_DECKS);
        setActiveDeckId(DEFAULT_DECK_ID);
        return {};
      }
    },
    [],
  );

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

      const basePages: Record<number, PageState> = {
        ...seed,
        ...pagesRef.current,
      };
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
      const relocations: Array<{
        oldPage: number;
        newPage: number;
        ps: PageState;
      }> = [];
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
          relocations.push({
            oldPage: entry.oldPage,
            newPage: found,
            ps: entry.ps,
          });
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

  const syncCurrentPage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // The plugin host can hold a cached view of the note (e.g. page count)
      // from whenever it was first opened; structural edits made while the
      // plugin was closed/backgrounded aren't picked up until this reloads it.
      await PluginCommAPI.reloadFile();

      const fileRes: any = await PluginCommAPI.getCurrentFilePath();
      const pageRes: any = await PluginCommAPI.getCurrentPageNum();

      const notePath = fileRes?.result;
      const page = pageRes?.result;

      if (!fileRes?.success || !notePath || typeof page !== 'number') {
        setError('Open a note page to use Cloze Quiz.');
        setLoading(false);
        return;
      }

      const previousNotePath = notePathRef.current;
      notePathRef.current = notePath;
      setCurrentPage(page);

      const totalRes: any = await PluginFileAPI.getNoteTotalPageNum(notePath);
      const total =
        totalRes?.success && typeof totalRes.result === 'number'
          ? totalRes.result
          : 1;
      const totalPagesValue = Math.max(1, total);
      setTotalPages(totalPagesValue);
      totalPagesRef.current = totalPagesValue;

      if (previousNotePath !== notePath) {
        // Switched to a different note (or first load) — the previous note's
        // clozes/decks must not leak into this one.
        setPages({});
      } else {
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
      }

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
    syncCurrentPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The plugin's JS context/React tree appears to only ever mount once, the
  // first time the sidebar button is tapped — reopening it later just re-shows
  // the same instance rather than remounting, so the effect above never fires
  // again and note edits made while "closed" are never picked up automatically.
  // `onStart`/`onStop` plugin-life events didn't reliably fire on re-open
  // either. The one signal that's guaranteed to fire every time the user
  // (re)opens this plugin is the sidebar button press itself.
  useEffect(() => {
    const sub = PluginManager.registerButtonListener({
      onButtonPress: (event: any) => {
        if (event?.id === CLOZE_BUTTON_ID) {
          syncCurrentPage();
        }
      },
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist decks + cloze positions/grades (not images, not `revealed`) whenever they change.
  useEffect(() => {
    const notePath = notePathRef.current;
    if (!notePath) {
      return;
    }
    const toSavePages: Record<number, PersistedPageEntry> = {};
    for (const [pageStr, ps] of Object.entries(pages)) {
      if (ps.clozes.length === 0) {
        continue;
      }
      toSavePages[Number(pageStr)] = {
        anchor: ps.anchor,
        clozes: ps.clozes.map(({id, x, y, width, height, grade, deckId}) => ({
          id,
          x,
          y,
          width,
          height,
          grade,
          deckId,
        })),
      };
    }
    const toSave: PersistedNoteData = {decks, pages: toSavePages};
    AsyncStorage.setItem(
      storageKeyForNote(notePath),
      JSON.stringify(toSave),
    ).catch(() => {});
  }, [pages, decks]);

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
    // Only the active deck's boxes are shown/interactive in edit mode, so only
    // those should block starting a new draft rect underneath them.
    const clozes = (
      pagesRef.current[currentPageRef.current]?.clozes ?? []
    ).filter(box => box.deckId === activeDeckIdRef.current);
    return clozes.some(box => {
      const bx = box.x * width;
      const by = box.y * height;
      const bw = box.width * width;
      const bh = box.height * height;
      return x >= bx && x <= bx + bw && y >= by && y <= by + bh;
    });
  };

  // Recreated only when mode changes; reads current page/cloze/deck data
  // through refs at call time so it never acts on stale state (see prior bug
  // where this was built once via useRef and froze `mode` at its initial value).
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
                deckId: activeDeckIdRef.current,
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
                ensurePageAnchor(notePath, page).then(anchor => {
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

  // Clears only the active deck's clozes on this page — other decks' clozes on
  // the same page are left alone (they aren't even visible right now). The
  // page anchor only gets cleaned up once the page has no clozes left at all.
  const clearCurrentPageClozes = () => {
    const page = currentPage;
    const anchor = pagesRef.current[page]?.anchor ?? null;
    let becameEmpty = false;
    setPages(prev => {
      const existing = prev[page];
      if (!existing) {
        return prev;
      }
      const clozes = existing.clozes.filter(c => c.deckId !== activeDeckId);
      becameEmpty = clozes.length === 0;
      return {
        ...prev,
        [page]: {
          ...existing,
          clozes,
          anchor: becameEmpty ? null : existing.anchor,
        },
      };
    });
    if (becameEmpty && anchor && notePathRef.current) {
      deletePageAnchor(notePathRef.current, page, anchor);
    }
  };

  // Deck CRUD. Decks are note-level metadata; clozes reference a deckId.
  const createDeck = useCallback((name: string) => {
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }
    const id = newDeckId();
    setDecks(prev => [...prev, {id, name: trimmed}]);
    setActiveDeckId(id);
  }, []);

  const renameDeck = useCallback((id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }
    setDecks(prev => prev.map(d => (d.id === id ? {...d, name: trimmed} : d)));
  }, []);

  // Deletes a deck and every cloze tagged with it (across all pages), cleaning
  // up each affected page's off-canvas marker if it becomes clozeless. Refuses
  // to delete the last remaining deck.
  const deleteDeckAndClozes = useCallback(
    async (id: string) => {
      if (decksRef.current.length <= 1) {
        return;
      }
      const notePath = notePathRef.current;
      if (notePath) {
        for (const [pStr, ps] of Object.entries(pagesRef.current)) {
          const willBeEmpty =
            ps.clozes.length > 0 && ps.clozes.every(c => c.deckId === id);
          if (willBeEmpty && ps.anchor) {
            await deletePageAnchor(notePath, Number(pStr), ps.anchor);
          }
        }
      }
      setPages(prev => {
        const next: Record<number, PageState> = {};
        for (const [pStr, ps] of Object.entries(prev)) {
          const clozes = ps.clozes.filter(c => c.deckId !== id);
          next[Number(pStr)] =
            clozes.length === 0
              ? {...ps, clozes: [], anchor: null}
              : {...ps, clozes};
        }
        return next;
      });
      const remaining = decksRef.current.filter(d => d.id !== id);
      setDecks(remaining);
      if (activeDeckIdRef.current === id) {
        setActiveDeckId(remaining[0]?.id ?? DEFAULT_DECK_ID);
      }
    },
    [deletePageAnchor],
  );

  const deckClozeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const ps of Object.values(pages)) {
      for (const c of ps.clozes) {
        counts.set(c.deckId, (counts.get(c.deckId) ?? 0) + 1);
      }
    }
    return counts;
  }, [pages]);

  const confirmDeleteDeckAndClozes = useCallback(
    (deck: Deck) => {
      if (decksRef.current.length <= 1) {
        Alert.alert('Cannot delete', 'You need at least one deck.');
        return;
      }
      const count = deckClozeCounts.get(deck.id) ?? 0;
      Alert.alert(
        `Delete "${deck.name}"?`,
        `This removes ${count} cloze${
          count === 1 ? '' : 's'
        } in this deck. This can't be undone.`,
        [
          {text: 'Cancel', style: 'cancel'},
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => deleteDeckAndClozes(deck.id),
          },
        ],
      );
    },
    [deckClozeCounts, deleteDeckAndClozes],
  );

  const buildQueue = (deckIds: Set<string>): QuizCard[] => {
    const order = Object.keys(pagesRef.current)
      .map(Number)
      .sort((a, b) => a - b);
    let cards: QuizCard[] = [];
    for (const p of order) {
      const clozes = pagesRef.current[p]?.clozes ?? [];
      for (const c of clozes) {
        if (deckIds.has(c.deckId)) {
          cards.push({page: p, id: c.id});
        }
      }
    }
    if (shuffle) {
      cards = shuffleArray(cards);
    }
    return cards;
  };

  const startQuiz = (deckIds: Set<string>) => {
    const cards = buildQueue(deckIds);
    if (cards.length === 0) {
      return;
    }
    const cardIds = new Set(cards.map(c => c.id));
    setPages(prev => {
      const next = {...prev};
      for (const [pStr, ps] of Object.entries(next)) {
        if (!ps.clozes.some(c => cardIds.has(c.id))) {
          continue;
        }
        next[Number(pStr)] = {
          ...ps,
          clozes: ps.clozes.map(c =>
            cardIds.has(c.id)
              ? {...c, revealed: false, grade: 'unseen' as Grade}
              : c,
          ),
        };
      }
      return next;
    });
    setActiveQuizDeckIds(Array.from(deckIds));
    setQuizQueue(cards);
    setQuizIndex(0);
    setMode('quiz');
    setScreen('editor');
  };

  const restartQuiz = () => startQuiz(new Set(activeQuizDeckIds));

  const openQuizPicker = () => {
    const withClozes = decks
      .filter(d => (deckClozeCounts.get(d.id) ?? 0) > 0)
      .map(d => d.id);
    setQuizPickerSelection(new Set(withClozes));
    setScreen('quizPicker');
  };

  const toggleQuizPickerDeck = (id: string) => {
    setQuizPickerSelection(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const quizPickerCount = useMemo(() => {
    let total = 0;
    for (const id of quizPickerSelection) {
      total += deckClozeCounts.get(id) ?? 0;
    }
    return total;
  }, [quizPickerSelection, deckClozeCounts]);

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
            ids.has(c.id)
              ? {...c, revealed: false, grade: 'unseen' as Grade}
              : c,
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
          clozes: pg.clozes.map(c =>
            c.id === card.id ? {...c, revealed: !c.revealed} : c,
          ),
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
          clozes: pg.clozes.map(c =>
            c.id === card.id ? {...c, revealed: true, grade} : c,
          ),
        },
      };
    });
    setQuizIndex(i => Math.min(i + 1, quizQueue.length));
  };

  const goPrevCard = () => setQuizIndex(i => Math.max(i - 1, 0));
  const goNextCard = () => setQuizIndex(i => Math.min(i + 1, quizQueue.length));

  const currentPageState = pages[currentPage];
  // Scoped to the active deck, matching what's actually shown/clearable in edit mode.
  const currentPageClozeCount =
    currentPageState?.clozes.filter(c => c.deckId === activeDeckId).length ?? 0;
  const totalClozesAllPages = useMemo(
    () => Object.values(pages).reduce((sum, ps) => sum + ps.clozes.length, 0),
    [pages],
  );

  const atSummary = mode === 'quiz' && quizIndex >= quizQueue.length;
  const currentCard =
    mode === 'quiz' && !atSummary ? quizQueue[quizIndex] : undefined;
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

  const activeDeck = decks.find(d => d.id === activeDeckId) ?? decks[0];

  const textColor = isDarkMode ? '#ffffff' : '#000000';
  const bg = isDarkMode ? '#000000' : '#ffffff';

  const title =
    mode === 'quiz'
      ? atSummary
        ? 'Quiz Me · Done'
        : `Quiz Me · Card ${quizIndex + 1}/${quizQueue.length}`
      : `Cloze Quiz${
          totalPages > 1 ? ` · Page ${currentPage + 1}/${totalPages}` : ''
        }`;

  return (
    <View style={[styles.container, {backgroundColor: bg}]}>
      <StatusBar
        barStyle={isDarkMode ? 'light-content' : 'dark-content'}
        backgroundColor={bg}
      />

      {screen === 'library' ? (
        <>
          <View style={styles.topBar}>
            <Pressable
              style={styles.iconButton}
              onPress={() => setScreen('editor')}>
              <Text style={[styles.iconText, {color: textColor}]}>‹</Text>
            </Pressable>
            <Text style={[styles.title, {color: textColor}]} numberOfLines={1}>
              Notes with Clozes
            </Text>
            <View style={styles.topBarActions}>
              <TouchableOpacity style={styles.pillButton} onPress={loadLibrary}>
                <Text style={styles.pillButtonText}>Refresh</Text>
              </TouchableOpacity>
            </View>
          </View>

          {libraryLoading ? (
            <View style={styles.centerFill}>
              <ActivityIndicator size="large" color={textColor} />
            </View>
          ) : library.length === 0 ? (
            <View style={styles.centerFill}>
              <Text style={[styles.errorText, {color: textColor}]}>
                No saved cloze data yet.
              </Text>
            </View>
          ) : (
            <ScrollView contentContainerStyle={styles.deckListContent}>
              {library.map(note => (
                <View key={note.notePath} style={styles.deckRow}>
                  <View style={styles.deckInfo}>
                    <Text
                      style={[styles.deckName, {color: textColor}]}
                      numberOfLines={1}>
                      {note.notePath.split('/').pop()}
                    </Text>
                    <Text style={styles.deckMeta}>
                      {note.pageCount} page{note.pageCount === 1 ? '' : 's'} ·{' '}
                      {note.clozeCount} cloze{note.clozeCount === 1 ? '' : 's'}
                      {note.notePath === notePathRef.current
                        ? ' · current note'
                        : ''}
                    </Text>
                  </View>
                  <TouchableOpacity
                    style={styles.deckDeleteButton}
                    onPress={() => confirmDeleteNoteData(note)}>
                    <Text style={styles.deckDeleteButtonText}>Delete</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </ScrollView>
          )}
        </>
      ) : screen === 'decks' ? (
        <>
          <View style={styles.topBar}>
            <Pressable
              style={styles.iconButton}
              onPress={() => setScreen('editor')}>
              <Text style={[styles.iconText, {color: textColor}]}>‹</Text>
            </Pressable>
            <Text style={[styles.title, {color: textColor}]} numberOfLines={1}>
              Decks in this Note
            </Text>
          </View>

          <ScrollView contentContainerStyle={styles.deckListContent}>
            {decks.map(deck => {
              const count = deckClozeCounts.get(deck.id) ?? 0;
              const isActive = deck.id === activeDeckId;
              const isRenaming = renamingDeckId === deck.id;
              return (
                <View
                  key={deck.id}
                  style={[styles.deckRow, isActive && styles.deckRowActive]}>
                  <View style={styles.deckInfo}>
                    {isRenaming ? (
                      <TextInput
                        style={[styles.deckNameInput, {color: textColor}]}
                        value={renameDraft}
                        onChangeText={setRenameDraft}
                        autoFocus
                        onSubmitEditing={() => {
                          renameDeck(deck.id, renameDraft);
                          setRenamingDeckId(null);
                        }}
                      />
                    ) : (
                      <TouchableOpacity
                        onPress={() => setActiveDeckId(deck.id)}>
                        <Text
                          style={[styles.deckName, {color: textColor}]}
                          numberOfLines={1}>
                          {deck.name}
                          {isActive ? ' (active)' : ''}
                        </Text>
                        <Text style={styles.deckMeta}>
                          {count} cloze{count === 1 ? '' : 's'}
                        </Text>
                      </TouchableOpacity>
                    )}
                  </View>
                  {isRenaming ? (
                    <TouchableOpacity
                      style={styles.deckDeleteButton}
                      onPress={() => {
                        renameDeck(deck.id, renameDraft);
                        setRenamingDeckId(null);
                      }}>
                      <Text style={styles.deckDeleteButtonText}>Save</Text>
                    </TouchableOpacity>
                  ) : (
                    <>
                      <TouchableOpacity
                        style={styles.deckDeleteButton}
                        onPress={() => {
                          setRenamingDeckId(deck.id);
                          setRenameDraft(deck.name);
                        }}>
                        <Text style={styles.deckDeleteButtonText}>Rename</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.deckDeleteButton}
                        onPress={() => confirmDeleteDeckAndClozes(deck)}
                        disabled={decks.length <= 1}>
                        <Text
                          style={[
                            styles.deckDeleteButtonText,
                            decks.length <= 1 && styles.pillButtonTextDisabled,
                          ]}>
                          Delete
                        </Text>
                      </TouchableOpacity>
                    </>
                  )}
                </View>
              );
            })}
          </ScrollView>

          <View style={styles.newDeckRow}>
            <TextInput
              style={[styles.newDeckInput, {color: textColor}]}
              placeholder="New deck name"
              placeholderTextColor="#888888"
              value={newDeckName}
              onChangeText={setNewDeckName}
              onSubmitEditing={() => {
                createDeck(newDeckName);
                setNewDeckName('');
              }}
            />
            <TouchableOpacity
              style={styles.pillButton}
              onPress={() => {
                createDeck(newDeckName);
                setNewDeckName('');
              }}
              disabled={!newDeckName.trim()}>
              <Text style={styles.pillButtonText}>Add</Text>
            </TouchableOpacity>
          </View>
        </>
      ) : screen === 'quizPicker' ? (
        <>
          <View style={styles.topBar}>
            <Pressable
              style={styles.iconButton}
              onPress={() => setScreen('editor')}>
              <Text style={[styles.iconText, {color: textColor}]}>‹</Text>
            </Pressable>
            <Text style={[styles.title, {color: textColor}]} numberOfLines={1}>
              Quiz: Pick Decks
            </Text>
            <View style={styles.topBarActions}>
              <TouchableOpacity
                style={styles.pillButton}
                onPress={() =>
                  setQuizPickerSelection(new Set(decks.map(d => d.id)))
                }>
                <Text style={styles.pillButtonText}>All</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.pillButton}
                onPress={() => setQuizPickerSelection(new Set())}>
                <Text style={styles.pillButtonText}>None</Text>
              </TouchableOpacity>
            </View>
          </View>

          <ScrollView contentContainerStyle={styles.deckListContent}>
            {decks.map(deck => {
              const count = deckClozeCounts.get(deck.id) ?? 0;
              const selected = quizPickerSelection.has(deck.id);
              return (
                <TouchableOpacity
                  key={deck.id}
                  style={[styles.deckRow, selected && styles.deckRowActive]}
                  onPress={() => toggleQuizPickerDeck(deck.id)}
                  disabled={count === 0}>
                  <View style={styles.deckCheckbox}>
                    {selected && <Text style={styles.deckCheckboxMark}>✓</Text>}
                  </View>
                  <View style={styles.deckInfo}>
                    <Text
                      style={[
                        styles.deckName,
                        {color: textColor},
                        count === 0 && styles.pillButtonTextDisabled,
                      ]}
                      numberOfLines={1}>
                      {deck.name}
                    </Text>
                    <Text style={styles.deckMeta}>
                      {count} cloze{count === 1 ? '' : 's'}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          <View style={styles.bottomBar}>
            <TouchableOpacity
              style={styles.modeButton}
              onPress={() => startQuiz(quizPickerSelection)}
              disabled={quizPickerCount === 0}>
              <Text
                style={[
                  styles.modeButtonText,
                  quizPickerCount === 0 && styles.modeButtonTextDisabled,
                ]}>
                Start Quiz ({quizPickerCount})
              </Text>
            </TouchableOpacity>
          </View>
        </>
      ) : (
        <>
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
                    onPress={() => {
                      setScreen('library');
                      loadLibrary();
                    }}>
                    <Text style={styles.pillButtonText}>Notes</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.pillButton}
                    onPress={() => setScreen('decks')}>
                    <Text
                      style={styles.pillButtonText}
                      numberOfLines={1}
                      ellipsizeMode="tail">
                      Deck: {activeDeck?.name ?? DEFAULT_DECK_NAME}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.pillButton}
                    onPress={clearCurrentPageClozes}
                    disabled={currentPageClozeCount === 0}>
                    <Text
                      style={[
                        styles.pillButtonText,
                        currentPageClozeCount === 0 &&
                          styles.pillButtonTextDisabled,
                      ]}>
                      Clear
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.pillButton}
                    onPress={() => setShuffle(s => !s)}>
                    <Text style={styles.pillButtonText}>
                      Shuffle: {shuffle ? 'On' : 'Off'}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.pillButton}
                    onPress={() => syncCurrentPage()}>
                    <Text style={styles.pillButtonText}>Refresh</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <>
                  {!atSummary && (
                    <TouchableOpacity
                      style={styles.pillButton}
                      onPress={resetCurrentQueue}>
                      <Text style={styles.pillButtonText}>Reset</Text>
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity
                    style={styles.pillButton}
                    onPress={() => setMode('edit')}>
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
                    currentPage === totalPages - 1 &&
                      styles.pillButtonTextDisabled,
                  ]}>
                  Next Page ›
                </Text>
              </TouchableOpacity>
            </View>
          )}

          {loading && (
            <View style={styles.centerFill}>
              <ActivityIndicator size="large" color={textColor} />
            </View>
          )}

          {!loading && error && (
            <View style={styles.centerFill}>
              <Text style={[styles.errorText, {color: textColor}]}>
                {error}
              </Text>
              <TouchableOpacity
                style={styles.retryButton}
                onPress={() => syncCurrentPage()}>
                <Text style={styles.retryButtonText}>Try Again</Text>
              </TouchableOpacity>
            </View>
          )}

          {!loading && !error && atSummary && (
            <View style={styles.centerFill}>
              <Text style={[styles.summaryTitle, {color: textColor}]}>
                Quiz complete
              </Text>
              <Text style={[styles.summaryScore, {color: textColor}]}>
                Got it: {quizStats.known} · Missed: {quizStats.missed} · Total:{' '}
                {quizStats.total}
              </Text>
            </View>
          )}

          {!loading && !error && !atSummary && currentPageState?.imageUri && (
            <View style={styles.pageArea}>
              <View
                style={[
                  styles.pageFrame,
                  {aspectRatio: 1 / (currentPageState.aspectRatio || 0.75)},
                ]}
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

                {(mode === 'edit'
                  ? currentPageState.clozes.filter(
                      b => b.deckId === activeDeckId,
                    )
                  : currentPageState.clozes
                ).map(box => {
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
                        style={[
                          styles.hiddenBox,
                          styles.focusedHiddenBox,
                          style,
                        ]}
                        onPress={revealCurrentCard}
                        activeOpacity={0.85}>
                        <Text style={styles.hiddenBoxText}>?</Text>
                      </TouchableOpacity>
                    );
                  }

                  return (
                    <View
                      key={box.id}
                      pointerEvents="none"
                      style={[styles.hiddenBox, style]}
                    />
                  );
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
                  <TouchableOpacity
                    style={[styles.modeButton, styles.modeButtonActive]}>
                    <Text
                      style={[
                        styles.modeButtonText,
                        styles.modeButtonTextActive,
                      ]}>
                      Edit Clozes
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.modeButton}
                    onPress={openQuizPicker}
                    disabled={totalClozesAllPages === 0}>
                    <Text
                      style={[
                        styles.modeButtonText,
                        totalClozesAllPages === 0 &&
                          styles.modeButtonTextDisabled,
                      ]}>
                      Quiz...
                      {totalClozesAllPages > 0
                        ? ` (${totalClozesAllPages})`
                        : ''}
                    </Text>
                  </TouchableOpacity>
                </>
              ) : atSummary ? (
                <>
                  <TouchableOpacity
                    style={styles.modeButton}
                    onPress={restartQuiz}>
                    <Text style={styles.modeButtonText}>Restart</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.modeButton}
                    onPress={() => setMode('edit')}>
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
                        <TouchableOpacity
                          style={styles.modeButton}
                          onPress={revealCurrentCard}>
                          <Text style={styles.modeButtonText}>Reveal</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={styles.modeButton}
                          onPress={goNextCard}>
                          <Text style={styles.modeButtonText}>Skip ›</Text>
                        </TouchableOpacity>
                      </>
                    )}
                  </View>
                </View>
              )}
            </View>
          )}
        </>
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
    maxWidth: 130,
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
  deckListContent: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  deckRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 12,
    marginBottom: 10,
  },
  deckRowActive: {
    borderWidth: 2,
  },
  deckCheckbox: {
    width: 22,
    height: 22,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  deckCheckboxMark: {
    fontSize: 14,
    fontWeight: '700',
  },
  deckInfo: {
    flex: 1,
    marginRight: 10,
  },
  deckName: {
    fontSize: 15,
    fontWeight: '600',
  },
  deckNameInput: {
    fontSize: 15,
    fontWeight: '600',
    borderBottomWidth: 1,
    borderColor: '#000000',
    paddingVertical: 2,
  },
  deckMeta: {
    fontSize: 12,
    color: '#888888',
    marginTop: 2,
  },
  deckDeleteButton: {
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginLeft: 6,
  },
  deckDeleteButtonText: {
    fontSize: 13,
    fontWeight: '600',
  },
  newDeckRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  newDeckInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginRight: 8,
    fontSize: 14,
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
