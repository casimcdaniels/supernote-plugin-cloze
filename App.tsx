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
import {PluginCommAPI, PluginFileAPI, PluginManager} from 'sn-plugin-lib';

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

interface PageState {
  imageUri: string | null;
  aspectRatio: number;
  clozes: ClozeBox[];
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

const MIN_BOX_PX = 14;
const STORAGE_PREFIX = 'clozequiz:v1:';

function storageKeyForNote(notePath: string): string {
  return `${STORAGE_PREFIX}${notePath}`;
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
        const existing = prev[page] ?? {imageUri: null, aspectRatio, clozes: []};
        return {
          ...prev,
          [page]: {...existing, imageUri: `file://${pngPath}`, aspectRatio},
        };
      });
    } catch (e) {
      setError('Something went wrong loading the page.');
    }
  }, []);

  const restorePersistedClozes = useCallback(async (notePath: string) => {
    try {
      const raw = await AsyncStorage.getItem(storageKeyForNote(notePath));
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as Record<string, PersistedClozeBox[]>;
      const restored: Record<number, PageState> = {};
      for (const [pageStr, boxes] of Object.entries(parsed)) {
        if (!Array.isArray(boxes) || boxes.length === 0) {
          continue;
        }
        restored[Number(pageStr)] = {
          imageUri: null,
          aspectRatio: 0.75,
          clozes: boxes.map(b => ({...b, revealed: false})),
        };
      }
      if (Object.keys(restored).length === 0) {
        return;
      }
      // In-memory state (if any already loaded this session) wins over the restored copy.
      setPages(prev => ({...restored, ...prev}));
    } catch (e) {
      // Corrupt or missing storage entry — just start with an empty deck.
    }
  }, []);

  const syncCurrentPage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fileRes: any = await PluginCommAPI.getCurrentFilePath();
      const pageRes: any = await PluginCommAPI.getCurrentPageNum();

      const notePath = fileRes?.result;
      const page = pageRes?.result;

      if (!fileRes?.success || !notePath || typeof page !== 'number') {
        setError('Open a note page to use Cloze Quiz.');
        setLoading(false);
        return;
      }

      notePathRef.current = notePath;
      setCurrentPage(page);

      const totalRes: any = await PluginFileAPI.getNoteTotalPageNum(notePath);
      const total =
        totalRes?.success && typeof totalRes.result === 'number' ? totalRes.result : 1;
      setTotalPages(Math.max(1, total));

      await restorePersistedClozes(notePath);
      await loadPageSnapshot(page, true);
    } catch (e) {
      setError('Something went wrong loading the page.');
    } finally {
      setLoading(false);
    }
  }, [loadPageSnapshot, restorePersistedClozes]);

  useEffect(() => {
    syncCurrentPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist cloze positions + grades (not images, not `revealed`) whenever they change.
  useEffect(() => {
    const notePath = notePathRef.current;
    if (!notePath) {
      return;
    }
    const toSave: Record<number, PersistedClozeBox[]> = {};
    for (const [pageStr, ps] of Object.entries(pages)) {
      if (ps.clozes.length === 0) {
        continue;
      }
      toSave[Number(pageStr)] = ps.clozes.map(({id, x, y, width, height, grade}) => ({
        id,
        x,
        y,
        width,
        height,
        grade,
      }));
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
              setPages(prevPages => {
                const existing = prevPages[page] ?? {
                  imageUri: null,
                  aspectRatio: 0.75,
                  clozes: [],
                };
                return {
                  ...prevPages,
                  [page]: {...existing, clozes: [...existing.clozes, box]},
                };
              });
            }
            return null;
          });
        },
      }),
    [mode],
  );

  const removeCloze = (id: string) => {
    const page = currentPage;
    setPages(prev => {
      const existing = prev[page];
      if (!existing) {
        return prev;
      }
      return {...prev, [page]: {...existing, clozes: existing.clozes.filter(c => c.id !== id)}};
    });
  };

  const clearCurrentPageClozes = () => {
    const page = currentPage;
    setPages(prev => {
      const existing = prev[page];
      if (!existing) {
        return prev;
      }
      return {...prev, [page]: {...existing, clozes: []}};
    });
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
              <TouchableOpacity style={styles.pillButton} onPress={syncCurrentPage}>
                <Text style={styles.pillButtonText}>Refresh</Text>
              </TouchableOpacity>
            </>
          ) : (
            !atSummary && (
              <TouchableOpacity style={styles.pillButton} onPress={resetCurrentQueue}>
                <Text style={styles.pillButtonText}>Reset</Text>
              </TouchableOpacity>
            )
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

      {loading && (
        <View style={styles.centerFill}>
          <ActivityIndicator size="large" color={textColor} />
        </View>
      )}

      {!loading && error && (
        <View style={styles.centerFill}>
          <Text style={[styles.errorText, {color: textColor}]}>{error}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={syncCurrentPage}>
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
