/**
 * Cloze Plugin
 *
 * Snapshots note pages and lets you draw opaque "cloze" boxes over them,
 * organized into named decks, then quiz yourself by tapping boxes one at a
 * time to reveal what's underneath and grading yourself.
 *
 * We track which page is which by planting a tiny invisible text marker on
 * a page the first time it gets clozed, and storing clozes under that
 * marker's uuid instead of the page number. That way, if pages get
 * reordered, inserted, or deleted, we don't have to go figure out where
 * everything moved to — we just read whatever marker is on the page we're
 * looking at. We only ever check the current page; other pages get checked
 * lazily as the user pages through. Page snapshots themselves aren't saved
 * anywhere, they're cheap enough to just regenerate whenever we need one.
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

interface PageState {
  imageUri: string | null;
  aspectRatio: number;
  clozes: ClozeBox[];
  // UUID for this page's marker element, or null if never clozed. Clozes
  // are looked up/persisted by this UUID, not by page index since
  // reordering/deletion of pages changes index.
  markerUuid: string | null;
  // Whether the marker lookup has run yet this session.
  identityChecked: boolean;
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
interface PersistedNoteData {
  decks: Deck[];
  // Keyed by marker UUID — see PageState.markerUuid.
  pagesByUuid: Record<string, PersistedClozeBox[]>;
}

const MIN_BOX_PX = 14;
// Must match the sidebar button's id in index.js's PluginManager.registerButton call.
const CLOZE_BUTTON_ID = 100;
const STORAGE_PREFIX = 'clozequiz:v6:';
const DEFAULT_DECK_ID = 'default';
const DEFAULT_DECK_NAME = 'Default';
const DEFAULT_DECKS: Deck[] = [{id: DEFAULT_DECK_ID, name: DEFAULT_DECK_NAME}];

// Prefix so the marker reads as an obvious plugin artifact if ever spotted,
// and the UUID can just be sliced off the end.
const MARKER_PREFIX = 'CLOZEID:';
// How far past the page's bottom-right corner to plant the marker, in pixels.
const MARKER_MARGIN = 20;
const MARKER_SIZE = 40;

function storageKeyForNote(notePath: string): string {
  return `${STORAGE_PREFIX}${notePath}`;
}

function newDeckId(): string {
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function newMarkerUuid(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function App(): React.JSX.Element {
  const isDarkMode = useColorScheme() === 'dark';

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [totalPages, setTotalPages] = useState(1);
  const [currentPage, setCurrentPage] = useState(0);
  const [pages, setPages] = useState<Record<number, PageState>>({});

  const [mode, setMode] = useState<Mode>('edit');
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
  // Everything persisted for the open note. This includes decks plus clozes for every
  // known marker uuid, not just the pages we've visited this session like
  // pages below. Loaded once per note, then kept up to date as we go.
  const persistedDataRef = useRef<PersistedNoteData | null>(null);

  const pagesRef = useRef<Record<number, PageState>>({});
  pagesRef.current = pages;
  // Tracks which pages we've already looked up (or are looking up) a marker
  // for this session, so we don't fire off the same getElements call twice.
  const pageIdentityRequestedRef = useRef<Set<number>>(new Set());
  // This ref tops us from firing two insertElements calls if the user draws a couple clozes on a fresh page
  // quickly. We clear a page out of here if the plant fails, so it can retry.
  const markerPlantRequestedRef = useRef<Set<number>>(new Set());
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
          markerUuid: null,
          identityChecked: false,
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

  // This function places a text marker outside of page margins and
  // uses its content as a stable id we can look the page up by later.
  const plantPageMarker = useCallback(
    async (notePath: string, page: number): Promise<string | null> => {
      try {
        const sizeRes: any = await PluginFileAPI.getPageSize(notePath, page);
        if (
          !sizeRes?.success ||
          !sizeRes.result?.width ||
          !sizeRes.result?.height
        ) {
          return null;
        }
        const left = sizeRes.result.width + MARKER_MARGIN;
        const top = sizeRes.result.height + MARKER_MARGIN;
        const uuid = newMarkerUuid();

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
          textContentFull: `${MARKER_PREFIX}${uuid}`,
          textRect: {
            left,
            top,
            right: left + MARKER_SIZE,
            bottom: top + MARKER_SIZE,
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
        return uuid;
      } catch (e) {
        return null;
      }
    },
    [],
  );

  const readPageMarkerUuid = useCallback(
    async (notePath: string, page: number): Promise<string | null> => {
      try {
        const res: any = await PluginFileAPI.getElements(page, notePath);
        const elements = res?.success ? res.result : null;
        if (!Array.isArray(elements)) {
          return null;
        }
        const marker = elements.find(
          (el: any) =>
            el?.type === Element.TYPE_TEXT &&
            typeof el?.textBox?.textContentFull === 'string' &&
            el.textBox.textContentFull.startsWith(MARKER_PREFIX),
        );
        return marker
          ? marker.textBox.textContentFull.slice(MARKER_PREFIX.length)
          : null;
      } catch (e) {
        return null;
      }
    },
    [],
  );

  // Loads a page's marker and clozes into state. We only do this once per
  // page per session; if no marker turns up we just clear out any clozes
  // that were sitting in that page slot.
  const loadPageIdentity = useCallback(
    async (page: number) => {
      const notePath = notePathRef.current;
      if (!notePath || pageIdentityRequestedRef.current.has(page)) {
        return;
      }
      pageIdentityRequestedRef.current.add(page);
      const uuid = await readPageMarkerUuid(notePath, page);
      const clozes = uuid
        ? (persistedDataRef.current?.pagesByUuid[uuid] ?? []).map(b => ({
            ...b,
            revealed: false,
          }))
        : [];
      setPages(prev => {
        const existing = prev[page] ?? {
          imageUri: null,
          aspectRatio: 0.75,
          clozes: [],
          markerUuid: null,
          identityChecked: false,
        };
        return {
          ...prev,
          [page]: {
            ...existing,
            markerUuid: uuid,
            clozes,
            identityChecked: true,
          },
        };
      });
    },
    [readPageMarkerUuid],
  );

  // Scans every note with saved cloze data for the library screen.
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
          for (const clozes of Object.values(parsed.pagesByUuid ?? {})) {
            if (clozes?.length) {
              pageCount++;
              clozeCount += clozes.length;
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

  // Wipes all saved cloze data for a note. Fingerprint marker is
  // left note alone if one exists.
  const deleteNoteData = useCallback(async (notePath: string) => {
    const key = storageKeyForNote(notePath);
    await AsyncStorage.removeItem(key);
    if (notePath === notePathRef.current) {
      setPages({});
      pageIdentityRequestedRef.current.clear();
      persistedDataRef.current = {decks: DEFAULT_DECKS, pagesByUuid: {}};
      setDecks(DEFAULT_DECKS);
      setActiveDeckId(DEFAULT_DECK_ID);
    }
    setLibrary(prev => prev.filter(n => n.notePath !== notePath));
  }, []);

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

  // Pulls the note's saved decks and clozes into persistedDataRef.
  const loadPersistedNoteData = useCallback(async (notePath: string) => {
    try {
      const raw = await AsyncStorage.getItem(storageKeyForNote(notePath));
      if (!raw) {
        persistedDataRef.current = {decks: DEFAULT_DECKS, pagesByUuid: {}};
        setDecks(DEFAULT_DECKS);
        setActiveDeckId(DEFAULT_DECK_ID);
        return;
      }
      const parsed = JSON.parse(raw) as PersistedNoteData;
      const restoredDecks =
        Array.isArray(parsed.decks) && parsed.decks.length > 0
          ? parsed.decks
          : DEFAULT_DECKS;
      persistedDataRef.current = {
        decks: restoredDecks,
        pagesByUuid: parsed.pagesByUuid ?? {},
      };
      setDecks(restoredDecks);
      // Only reset if the current selection doesn't exist in this note's deck
      // list — otherwise a resync would silently revert the user's switch.
      setActiveDeckId(prev =>
        restoredDecks.some(d => d.id === prev) ? prev : restoredDecks[0].id,
      );
    } catch (e) {
      // Corrupt or missing storage entry — just start with an empty deck.
      persistedDataRef.current = {decks: DEFAULT_DECKS, pagesByUuid: {}};
      setDecks(DEFAULT_DECKS);
      setActiveDeckId(DEFAULT_DECK_ID);
    }
  }, []);

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
        // Different note than what we had open before, so wipe everything
        // rather than risk leaking the old note's clozes/decks into this one.
        setPages({});
        pageIdentityRequestedRef.current.clear();
      } else {
        // Same note, but it might have changed while we were closed, so drop
        // the cached page images and re-check every page's marker next time
        // we visit it.
        pageIdentityRequestedRef.current.clear();
        setPages(prev => {
          const next: Record<number, PageState> = {};
          for (const [pStr, ps] of Object.entries(prev)) {
            next[Number(pStr)] = {
              ...ps,
              imageUri: null,
              identityChecked: false,
            };
          }
          return next;
        });
      }

      await loadPersistedNoteData(notePath);
      // We only check the current page's marker here. Other pages get
      // checked lazily as the user pages through, in goToPage.
      await loadPageIdentity(page);
      await loadPageSnapshot(page, true);
    } catch (e) {
      setError('Something went wrong loading the page.');
    } finally {
      setLoading(false);
    }
  }, [loadPageSnapshot, loadPersistedNoteData, loadPageIdentity]);

  useEffect(() => {
    syncCurrentPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The plugin only mounts once per JS lifetime, so just opening it again
  // doesn't remount and rerun the effect above.
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

  // Save decks and cloze positions/grades whenever they change. We merge our
  // changes into persistedDataRef instead of overwriting it wholesale,
  // because `pages` only knows about the pages we've visited this session —
  // clozes for other uuids need to stay put.
  useEffect(() => {
    const notePath = notePathRef.current;
    const data = persistedDataRef.current;
    if (!notePath || !data) {
      return;
    }
    data.decks = decks;
    for (const ps of Object.values(pages)) {
      if (!ps.markerUuid) {
        continue;
      }
      if (ps.clozes.length === 0) {
        delete data.pagesByUuid[ps.markerUuid];
        continue;
      }
      data.pagesByUuid[ps.markerUuid] = ps.clozes.map(
        ({id, x, y, width, height, grade, deckId}) => ({
          id,
          x,
          y,
          width,
          height,
          grade,
          deckId,
        }),
      );
    }
    AsyncStorage.setItem(
      storageKeyForNote(notePath),
      JSON.stringify(data),
    ).catch(() => {});
  }, [pages, decks]);

  const goToPage = (delta: number) => {
    const next = Math.min(Math.max(currentPage + delta, 0), totalPages - 1);
    if (next === currentPage) {
      return;
    }
    setCurrentPage(next);
    loadPageIdentity(next);
    if (!pagesRef.current[next]?.imageUri) {
      loadPageSnapshot(next);
    }
  };

  // Pages that have at least one cloze in the active deck. This is used to jump
  // straight between clozed pages instead of stepping one page at a time.
  const clozedPagesForActiveDeck = useMemo(
    () =>
      Object.keys(pages)
        .map(Number)
        .filter(p =>
          (pages[p]?.clozes ?? []).some(c => c.deckId === activeDeckId),
        )
        .sort((a, b) => a - b),
    [pages, activeDeckId],
  );
  const hasPrevClozedPage = clozedPagesForActiveDeck.some(p => p < currentPage);
  const hasNextClozedPage = clozedPagesForActiveDeck.some(p => p > currentPage);

  const goToAdjacentClozedPage = (direction: 1 | -1) => {
    const target =
      direction === 1
        ? clozedPagesForActiveDeck.find(p => p > currentPage)
        : [...clozedPagesForActiveDeck].reverse().find(p => p < currentPage);
    if (target === undefined) {
      return;
    }
    setCurrentPage(target);
    if (!pagesRef.current[target]?.imageUri) {
      loadPageSnapshot(target);
    }
  };

  const isInsideAnyBox = (x: number, y: number) => {
    const {width, height} = containerSize.current;
    if (!width || !height) {
      return false;
    }
    // Only boxes from the active deck are shown in edit mode, so those are
    // the only ones that should stop a new draft rect from starting here.
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

  // We only rebuild this when mode changes, and read page/cloze/deck data
  // through refs at call time so it's never working off stale state. We got
  // burned by this before, when it was built once with useRef and ended up
  // stuck on whatever mode was at mount time.
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
              setPages(prevPages => {
                const existing = prevPages[page] ?? {
                  imageUri: null,
                  aspectRatio: 0.75,
                  clozes: [],
                  markerUuid: null,
                  identityChecked: false,
                };
                return {
                  ...prevPages,
                  [page]: {...existing, clozes: [...existing.clozes, box]},
                };
              });
              // If this is the first cloze on the page, plant a marker so it
              // can survive reordering later. We wait for the identity check
              // to confirm there's no marker yet, otherwise we could end up
              // planting a second one while the read is still in flight.
              if (
                pagesRef.current[page]?.identityChecked &&
                !pagesRef.current[page]?.markerUuid &&
                !markerPlantRequestedRef.current.has(page) &&
                notePathRef.current
              ) {
                markerPlantRequestedRef.current.add(page);
                const notePath = notePathRef.current;
                plantPageMarker(notePath, page).then(uuid => {
                  if (!uuid) {
                    markerPlantRequestedRef.current.delete(page); // allow retry
                    return;
                  }
                  if (persistedDataRef.current) {
                    persistedDataRef.current.pagesByUuid[uuid] = [];
                  }
                  setPages(prevPages => {
                    const existing = prevPages[page];
                    if (!existing || existing.markerUuid) {
                      return prevPages;
                    }
                    return {
                      ...prevPages,
                      [page]: {...existing, markerUuid: uuid},
                    };
                  });
                });
              }
            }
            return null;
          });
        },
      }),
    [mode, plantPageMarker],
  );

  const removeCloze = (id: string) => {
    const page = currentPage;
    setPages(prev => {
      const existing = prev[page];
      if (!existing) {
        return prev;
      }
      const clozes = existing.clozes.filter(c => c.id !== id);
      return {...prev, [page]: {...existing, clozes}};
    });
  };

  const clearCurrentPageClozes = () => {
    const page = currentPage;
    setPages(prev => {
      const existing = prev[page];
      if (!existing) {
        return prev;
      }
      const clozes = existing.clozes.filter(c => c.deckId !== activeDeckId);
      return {...prev, [page]: {...existing, clozes}};
    });
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

  // Deletes a deck and every cloze in it. We have to update both `pages`
  // (for pages we've visited) and persistedDataRef directly, since clozes on
  // pages we haven't visited this session only live in persistedDataRef.
  // Keeps at least the last deck around, since clozes need a deck to live in.
  const deleteDeckAndClozes = useCallback((id: string) => {
    if (decksRef.current.length <= 1) {
      return;
    }
    setPages(prev => {
      const next: Record<number, PageState> = {};
      for (const [pStr, ps] of Object.entries(prev)) {
        next[Number(pStr)] = {
          ...ps,
          clozes: ps.clozes.filter(c => c.deckId !== id),
        };
      }
      return next;
    });
    const data = persistedDataRef.current;
    if (data) {
      for (const uuid of Object.keys(data.pagesByUuid)) {
        const filtered = data.pagesByUuid[uuid].filter(c => c.deckId !== id);
        if (filtered.length === 0) {
          delete data.pagesByUuid[uuid];
        } else {
          data.pagesByUuid[uuid] = filtered;
        }
      }
    }
    const remaining = decksRef.current.filter(d => d.id !== id);
    setDecks(remaining);
    if (activeDeckIdRef.current === id) {
      setActiveDeckId(remaining[0]?.id ?? DEFAULT_DECK_ID);
    }
  }, []);

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
    const cards: QuizCard[] = [];
    for (const p of order) {
      const clozes = pagesRef.current[p]?.clozes ?? [];
      for (const c of clozes) {
        if (deckIds.has(c.deckId)) {
          cards.push({page: p, id: c.id});
        }
      }
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
  const noteBarBg = isDarkMode ? '#1a1a1a' : '#ececec';
  const noteFileName = notePathRef.current?.split('/').pop() ?? '';

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
          <View
            style={[
              styles.noteBar,
              {backgroundColor: noteBarBg, borderBottomColor: textColor},
            ]}>
            <Text
              style={[styles.noteBarText, {color: textColor}]}
              numberOfLines={1}>
              {noteFileName}
            </Text>
          </View>

          <View style={[styles.toolbar, {borderBottomColor: textColor}]}>
            <Pressable style={styles.iconButton} onPress={handleClose}>
              <Text style={[styles.iconText, {color: textColor}]}>✕</Text>
            </Pressable>

            {mode === 'edit' && (
              <Pressable
                style={styles.iconButton}
                onPress={() => {
                  setScreen('library');
                  loadLibrary();
                }}>
                <Text style={[styles.iconText, {color: textColor}]}>☰</Text>
              </Pressable>
            )}

            <TouchableOpacity
              style={styles.tabButton}
              onPress={() => setMode('edit')}>
              <Text
                style={[
                  styles.tabText,
                  {color: textColor},
                  mode === 'edit' && styles.tabTextActive,
                ]}>
                Edit
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.tabButton}
              disabled={mode === 'edit' && totalClozesAllPages === 0}
              onPress={() => {
                if (mode !== 'quiz') {
                  openQuizPicker();
                }
              }}>
              <Text
                style={[
                  styles.tabText,
                  {color: textColor},
                  mode === 'quiz' && styles.tabTextActive,
                  mode === 'edit' &&
                    totalClozesAllPages === 0 &&
                    styles.pillButtonTextDisabled,
                ]}>
                Quiz
              </Text>
            </TouchableOpacity>

            {mode === 'edit' && (
              <TouchableOpacity
                style={styles.toolbarButton}
                onPress={() => setScreen('decks')}>
                <Text style={styles.toolbarIcon}>▤</Text>
                <Text
                  style={styles.toolbarCaption}
                  numberOfLines={1}
                  ellipsizeMode="tail">
                  {activeDeck?.name ?? DEFAULT_DECK_NAME}
                </Text>
              </TouchableOpacity>
            )}

            {mode === 'edit' ? (
              <>
                {totalPages > 1 && (
                  <>
                    <View
                      style={[styles.toolbarDivider, styles.toolbarDividerPush]}
                    />
                    <TouchableOpacity
                      style={styles.toolbarButton}
                      onPress={() => goToAdjacentClozedPage(-1)}
                      disabled={!hasPrevClozedPage}>
                      <Text
                        style={[
                          styles.toolbarIcon,
                          !hasPrevClozedPage && styles.toolbarIconDisabled,
                        ]}>
                        «
                      </Text>
                      <Text
                        style={[
                          styles.toolbarCaption,
                          !hasPrevClozedPage && styles.toolbarCaptionDisabled,
                        ]}>
                        Cloze
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.toolbarButton}
                      onPress={() => goToPage(-1)}
                      disabled={currentPage === 0}>
                      <Text
                        style={[
                          styles.toolbarIcon,
                          currentPage === 0 && styles.toolbarIconDisabled,
                        ]}>
                        ‹
                      </Text>
                      <Text
                        style={[
                          styles.toolbarCaption,
                          currentPage === 0 && styles.toolbarCaptionDisabled,
                        ]}>
                        Prev
                      </Text>
                    </TouchableOpacity>
                    <Text style={[styles.toolbarPageText, {color: textColor}]}>
                      {currentPage + 1}/{totalPages}
                    </Text>
                    <TouchableOpacity
                      style={styles.toolbarButton}
                      onPress={() => goToPage(1)}
                      disabled={currentPage === totalPages - 1}>
                      <Text
                        style={[
                          styles.toolbarIcon,
                          currentPage === totalPages - 1 &&
                            styles.toolbarIconDisabled,
                        ]}>
                        ›
                      </Text>
                      <Text
                        style={[
                          styles.toolbarCaption,
                          currentPage === totalPages - 1 &&
                            styles.toolbarCaptionDisabled,
                        ]}>
                        Next
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.toolbarButton}
                      onPress={() => goToAdjacentClozedPage(1)}
                      disabled={!hasNextClozedPage}>
                      <Text
                        style={[
                          styles.toolbarIcon,
                          !hasNextClozedPage && styles.toolbarIconDisabled,
                        ]}>
                        »
                      </Text>
                      <Text
                        style={[
                          styles.toolbarCaption,
                          !hasNextClozedPage && styles.toolbarCaptionDisabled,
                        ]}>
                        Cloze
                      </Text>
                    </TouchableOpacity>
                  </>
                )}
                <View
                  style={[
                    styles.toolbarDivider,
                    totalPages <= 1 && styles.toolbarDividerPush,
                  ]}
                />
                <View style={styles.toolbarActionsGroup}>
                  <TouchableOpacity
                    style={styles.toolbarButton}
                    onPress={clearCurrentPageClozes}
                    disabled={currentPageClozeCount === 0}>
                    <Text
                      style={[
                        styles.toolbarIcon,
                        currentPageClozeCount === 0 &&
                          styles.toolbarIconDisabled,
                      ]}>
                      ⌫
                    </Text>
                    <Text
                      style={[
                        styles.toolbarCaption,
                        currentPageClozeCount === 0 &&
                          styles.toolbarCaptionDisabled,
                      ]}>
                      Clear
                    </Text>
                  </TouchableOpacity>
                </View>
              </>
            ) : (
              !atSummary && (
                <>
                  <View
                    style={[styles.toolbarDivider, styles.toolbarDividerPush]}
                  />
                  <View style={styles.toolbarActionsGroup}>
                    <TouchableOpacity
                      style={styles.toolbarButton}
                      onPress={resetCurrentQueue}>
                      <Text style={styles.toolbarIcon}>⟲</Text>
                      <Text style={styles.toolbarCaption}>Reset</Text>
                    </TouchableOpacity>
                  </View>
                </>
              )
            )}
          </View>

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
                  : currentPageState.clozes.filter(b =>
                      activeQuizDeckIds.includes(b.deckId),
                    )
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

          {!loading && !error && mode === 'quiz' && (
            <View style={styles.bottomBar}>
              {atSummary ? (
                <TouchableOpacity
                  style={styles.modeButton}
                  onPress={restartQuiz}>
                  <Text style={styles.modeButtonText}>Restart</Text>
                </TouchableOpacity>
              ) : (
                <View style={styles.quizControls}>
                  <View style={styles.quizStatsRow}>
                    <Text style={[styles.quizStatsText, {color: textColor}]}>
                      Card {quizIndex + 1}/{quizQueue.length} · ✓{' '}
                      {quizStats.known} · ✕ {quizStats.missed}
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
  noteBar: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderBottomWidth: 1,
  },
  noteBarText: {
    fontSize: 11,
    fontWeight: '600',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingTop: 12,
    paddingBottom: 8,
  },
  iconButton: {
    width: 50,
    height: 50,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 4,
    borderRadius: 10,
  },
  iconText: {
    fontSize: 24,
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
  toolbar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 10,
    borderBottomWidth: 1,
  },
  toolbarActionsGroup: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  toolbarDivider: {
    width: 1,
    height: 32,
    backgroundColor: '#00000033',
    marginHorizontal: 8,
  },
  toolbarDividerPush: {
    marginLeft: 'auto',
  },
  toolbarButton: {
    width: 50,
    height: 50,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 4,
    marginRight: 4,
    marginBottom: 4,
    borderRadius: 10,
  },
  toolbarIcon: {
    fontSize: 32,
    fontWeight: '600',
    color: '#000000',
  },
  toolbarIconDisabled: {
    color: '#aaaaaa',
  },
  toolbarCaption: {
    fontSize: 14,
    fontWeight: '600',
    color: '#000000',
    marginTop: 2,
  },
  toolbarCaptionDisabled: {
    color: '#aaaaaa',
  },
  toolbarPageText: {
    fontSize: 14,
    fontWeight: '600',
    marginRight: 6,
    marginBottom: 6,
  },
  tabButton: {
    height: 50,
    justifyContent: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginRight: 4,
  },
  tabText: {
    fontSize: 19,
    fontWeight: '500',
  },
  tabTextActive: {
    fontWeight: '700',
    textDecorationLine: 'underline',
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
  modeButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#000000',
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
