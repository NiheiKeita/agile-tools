import { useCallback, useEffect, useRef, useState } from 'react';
import { useSnackbar } from 'notistack';
import { useWebPubSub } from '@/hooks/useWebPubSub';
import type { PeerMessage, Participant, VotingHistoryItem, RoomHistory } from '@/types';

interface UserInfo {
  userId: string;
  nickname: string;
}

const HEARTBEAT_TIMEOUT = 15000; // 15秒で切断と判定
const HEARTBEAT_CHECK_INTERVAL = 5000; // 5秒ごとにチェック

export function useRoomState(roomId: string) {
  const { enqueueSnackbar } = useSnackbar();
  const [isLoading, setIsLoading] = useState(true);
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);
  const [isHost, setIsHost] = useState(false);
  const [selectedCard, setSelectedCard] = useState<string | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [votes, setVotes] = useState<Record<string, string>>({});
  const [isRevealed, setIsRevealed] = useState(false);
  const [facilitatorId, setFacilitatorId] = useState<string>('');
  const [allVotedNotified, setAllVotedNotified] = useState(false);
  const [teamName, setTeamName] = useState<string | undefined>(undefined);
  const [story, setStory] = useState<string | null>(null);
  const [storyUrl, setStoryUrl] = useState<string | null>(null);
  const [history, setHistory] = useState<VotingHistoryItem[]>([]);

  // コールバック内で最新の状態を参照するための ref
  const stateRef = useRef({
    participants: [] as Participant[],
    votes: {} as Record<string, string>,
    isRevealed: false,
    facilitatorId: '',
    story: null as string | null,
    storyUrl: null as string | null,
  });
  useEffect(() => {
    stateRef.current = { participants, votes, isRevealed, facilitatorId, story, storyUrl };
  }, [participants, votes, isRevealed, facilitatorId, story, storyUrl]);

  // heartbeat 追跡用
  const heartbeatMapRef = useRef<Map<string, number>>(new Map());

  // localStorageから履歴を読み込み（ホストのみ）
  useEffect(() => {
    if (typeof window !== 'undefined' && isHost) {
      const saved = localStorage.getItem(`room:${roomId}:history`);
      if (saved) {
        try {
          const data = JSON.parse(saved);
          if (Array.isArray(data)) {
            const roomHistory: RoomHistory = {
              roomId,
              teamName: teamName,
              createdAt: new Date().toISOString(),
              votingHistory: data,
            };
            localStorage.setItem(`room:${roomId}:history`, JSON.stringify(roomHistory));
            setHistory(data);
          } else if (data.votingHistory) {
            setHistory(data.votingHistory);
          }
        } catch (e) {
          console.error('Failed to parse history:', e);
        }
      }
    }
  }, [roomId, isHost, teamName]);

  // セッションストレージからユーザー情報を取得
  useEffect(() => {
    let mounted = true;

    if (typeof window !== 'undefined') {
      const timer = setTimeout(() => {
        if (!mounted) return;

        const stored = sessionStorage.getItem(`room:${roomId}:user`);
        const hostId = sessionStorage.getItem(`room:${roomId}:host`);
        const savedTeamName = sessionStorage.getItem(`room:${roomId}:teamName`);

        if (stored) {
          const info = JSON.parse(stored);
          setUserInfo(info);
          if (hostId === info.userId) {
            setIsHost(true);
            setFacilitatorId(info.userId);
          }
        }

        if (savedTeamName) {
          setTeamName(savedTeamName);
        }

        setIsLoading(false);
      }, 100);

      return () => {
        mounted = false;
        clearTimeout(timer);
      };
    } else {
      setIsLoading(false);
    }
  }, [roomId]);

  // facilitatorId が変更されたときに isHost を更新
  useEffect(() => {
    if (userInfo && facilitatorId) {
      setIsHost(userInfo.userId === facilitatorId);
    }
  }, [userInfo, facilitatorId]);

  // sendRef: handleMessage 内から send を呼ぶための参照
  const sendRef = useRef<(msg: PeerMessage) => void>(() => {});

  // P2P メッセージハンドラー
  const handleMessage = useCallback((message: PeerMessage) => {
    switch (message.type) {
      case 'join':
        setParticipants((prev) => {
          if (prev.find(p => p.id === message.userId)) return prev;
          return [...prev, { id: message.userId, nickname: message.nickname, hasVoted: false }];
        });
        // heartbeat 記録
        heartbeatMapRef.current.set(message.userId, Date.now());

        // ホストの場合、新規参加者に現在の状態を送信
        if (isHost && userInfo) {
          // 少し遅延して最新の state を使う
          setTimeout(() => {
            const s = stateRef.current;
            sendRef.current({
              type: 'syncResponse',
              targetUserId: message.userId,
              state: {
                roomId,
                participants: [
                  ...s.participants,
                  // 今 join した人がまだ stateRef に反映されてない場合に追加
                  ...(!s.participants.find(p => p.id === message.userId)
                    ? [{ id: message.userId, nickname: message.nickname, hasVoted: false }]
                    : []),
                ],
                votes: s.isRevealed ? s.votes : {},
                isRevealed: s.isRevealed,
                facilitatorId: s.facilitatorId,
                story: s.story,
                storyUrl: s.storyUrl,
              },
            });
          }, 100);
        }

        // ホストとして参加した人の facilitatorId を設定
        if (message.isHost) {
          setFacilitatorId(message.userId);
        }
        break;

      case 'leave':
        setParticipants((prev) => prev.filter((p) => p.id !== message.userId));
        setVotes((prev) => {
          const next = { ...prev };
          delete next[message.userId];
          return next;
        });
        heartbeatMapRef.current.delete(message.userId);
        break;

      case 'vote':
        // 投票値をローカルに保存（UI は isRevealed まで非表示）
        setVotes((prev) => ({ ...prev, [message.userId]: message.value }));
        setParticipants((prev) =>
          prev.map((p) =>
            p.id === message.userId ? { ...p, hasVoted: true } : p
          )
        );
        break;

      case 'reveal':
        setIsRevealed(true);
        break;

      case 'reset':
        setIsRevealed(false);
        setVotes({});
        setSelectedCard(null);
        setAllVotedNotified(false);
        setStory(null);
        setStoryUrl(null);
        setParticipants((prev) =>
          prev.map((p) => ({ ...p, hasVoted: false }))
        );
        break;

      case 'setStory':
        setStory(message.story || null);
        setStoryUrl(message.storyUrl || null);
        break;

      case 'heartbeat':
        heartbeatMapRef.current.set(message.userId, Date.now());
        // heartbeat で未知の参加者を検出した場合、追加する
        setParticipants((prev) => {
          if (prev.find(p => p.id === message.userId)) return prev;
          return [...prev, { id: message.userId, nickname: message.nickname, hasVoted: false }];
        });
        break;

      case 'syncResponse':
        // 自分宛ての syncResponse のみ処理
        if (userInfo && message.targetUserId === userInfo.userId) {
          setParticipants(message.state.participants);
          setVotes(message.state.votes);
          setIsRevealed(message.state.isRevealed);
          setFacilitatorId(message.state.facilitatorId);
          setStory(message.state.story);
          setStoryUrl(message.state.storyUrl);
          // 既存参加者の heartbeat を初期化
          message.state.participants.forEach(p => {
            if (p.id !== userInfo.userId) {
              heartbeatMapRef.current.set(p.id, Date.now());
            }
          });
        }
        break;
    }
  }, [isHost, userInfo, roomId]);

  const { isConnected, send } = useWebPubSub({
    roomId,
    userId: userInfo?.userId ?? '',
    nickname: userInfo?.nickname ?? '',
    isHost,
    onMessage: handleMessage,
    enabled: !!userInfo,
  });

  // sendRef を常に最新に保つ
  useEffect(() => {
    sendRef.current = send;
  }, [send]);

  // 接続時に自分自身を参加者リストに追加
  useEffect(() => {
    if (isConnected && userInfo) {
      setParticipants((prev) => {
        if (prev.find(p => p.id === userInfo.userId)) return prev;
        return [...prev, { id: userInfo.userId, nickname: userInfo.nickname, hasVoted: false }];
      });
    }
  }, [isConnected, userInfo]);

  // heartbeat タイムアウトによる切断検知
  useEffect(() => {
    if (!isConnected || !userInfo) return;

    const interval = setInterval(() => {
      const now = Date.now();
      const disconnected: string[] = [];

      heartbeatMapRef.current.forEach((lastSeen, peerId) => {
        if (peerId !== userInfo.userId && now - lastSeen > HEARTBEAT_TIMEOUT) {
          disconnected.push(peerId);
        }
      });

      if (disconnected.length > 0) {
        disconnected.forEach(id => heartbeatMapRef.current.delete(id));
        setParticipants((prev) => prev.filter((p) => !disconnected.includes(p.id)));
        setVotes((prev) => {
          const next = { ...prev };
          disconnected.forEach(id => delete next[id]);
          return next;
        });
      }
    }, HEARTBEAT_CHECK_INTERVAL);

    return () => clearInterval(interval);
  }, [isConnected, userInfo]);

  // 全員投票完了の検出と通知
  useEffect(() => {
    if (isRevealed || participants.length === 0 || allVotedNotified) return;

    const allVoted = participants.every((p) => p.hasVoted);
    if (allVoted && participants.length > 0) {
      enqueueSnackbar('全員がカードを選択しました！', {
        variant: 'success',
        autoHideDuration: 3000,
      });
      setAllVotedNotified(true);
    }
  }, [participants, isRevealed, allVotedNotified, enqueueSnackbar]);

  // カード選択（ローカル更新 + グループ送信）
  const handleCardSelect = useCallback((card: string) => {
    if (isRevealed || !userInfo) return;
    setSelectedCard(card);
    setVotes((prev) => ({ ...prev, [userInfo.userId]: card }));
    setParticipants((prev) =>
      prev.map((p) => p.id === userInfo.userId ? { ...p, hasVoted: true } : p)
    );
    send({ type: 'vote', userId: userInfo.userId, value: card });
  }, [isRevealed, userInfo, send]);

  // カード公開（ローカル更新 + グループ送信 + 履歴保存）
  const handleReveal = useCallback(() => {
    if (!isHost || !userInfo) return;
    setIsRevealed(true);
    send({ type: 'reveal', userId: userInfo.userId });

    // 履歴に保存
    const currentParticipants = stateRef.current.participants;
    const currentVotes = stateRef.current.votes;
    const currentStory = stateRef.current.story;
    const currentStoryUrl = stateRef.current.storyUrl;

    const participantNames: Record<string, string> = {};
    currentParticipants.forEach(p => {
      participantNames[p.id] = p.nickname;
    });

    const historyItem: VotingHistoryItem = {
      id: crypto.randomUUID(),
      story: currentStory || '(ストーリー未設定)',
      storyUrl: currentStoryUrl || undefined,
      votes: { ...currentVotes },
      participantNames,
      votedAt: new Date().toISOString(),
    };

    setHistory(prev => {
      const newHistory = [...prev, historyItem];
      saveHistoryToStorage(roomId, teamName, newHistory);
      return newHistory;
    });
  }, [isHost, userInfo, send, roomId, teamName]);

  // リセット（ローカル更新 + グループ送信）
  const handleReset = useCallback(() => {
    if (!isHost || !userInfo) return;
    setIsRevealed(false);
    setVotes({});
    setSelectedCard(null);
    setAllVotedNotified(false);
    setStory(null);
    setStoryUrl(null);
    setParticipants((prev) => prev.map((p) => ({ ...p, hasVoted: false })));
    send({ type: 'reset', userId: userInfo.userId });
  }, [isHost, userInfo, send]);

  // 招待リンクコピー
  const handleCopyLink = useCallback(() => {
    if (typeof window !== 'undefined') {
      const url = window.location.href;
      navigator.clipboard.writeText(url);
      enqueueSnackbar('招待リンクをコピーしました', { variant: 'success' });
    }
  }, [enqueueSnackbar]);

  // ルーム参加
  const handleJoinRoom = useCallback((nickname: string) => {
    if (typeof window !== 'undefined') {
      const userId = crypto.randomUUID();
      const info = { userId, nickname };
      sessionStorage.setItem(`room:${roomId}:user`, JSON.stringify(info));
      setUserInfo(info);
    }
  }, [roomId]);

  // ストーリー設定（ローカル更新 + グループ送信）
  const handleSetStory = useCallback((newStory: string, newStoryUrl: string) => {
    if (!isHost || !userInfo) return;
    setStory(newStory || null);
    setStoryUrl(newStoryUrl || null);
    send({ type: 'setStory', userId: userInfo.userId, story: newStory, storyUrl: newStoryUrl });
  }, [isHost, userInfo, send]);

  // ストーリークリア
  const handleClearStory = useCallback(() => {
    if (!isHost || !userInfo) return;
    setStory(null);
    setStoryUrl(null);
    send({ type: 'setStory', userId: userInfo.userId, story: '', storyUrl: '' });
  }, [isHost, userInfo, send]);

  // 見積もり設定
  const handleSetEstimate = useCallback((estimate: string) => {
    if (!isHost || !isRevealed) return;

    setHistory(prev => {
      if (prev.length === 0) return prev;

      const newHistory = [...prev];
      const latest = { ...newHistory[newHistory.length - 1] };
      latest.estimate = estimate;
      newHistory[newHistory.length - 1] = latest;

      saveHistoryToStorage(roomId, teamName, newHistory);
      return newHistory;
    });

    enqueueSnackbar(`見積もりを ${estimate} に設定しました`, {
      variant: 'success',
    });
  }, [isHost, isRevealed, roomId, teamName, enqueueSnackbar]);

  return {
    isLoading,
    userInfo,
    setUserInfo,
    isHost,
    isConnected,
    selectedCard,
    participants,
    votes,
    isRevealed,
    facilitatorId,
    allVotedNotified,
    teamName,
    story,
    storyUrl,
    history,
    handleCardSelect,
    handleReveal,
    handleReset,
    handleCopyLink,
    handleJoinRoom,
    handleSetStory,
    handleClearStory,
    handleSetEstimate,
  };
}

/** localStorage に RoomHistory 形式で履歴を保存 */
function saveHistoryToStorage(roomId: string, teamName: string | undefined, votingHistory: VotingHistoryItem[]) {
  if (typeof window === 'undefined') return;

  const saved = localStorage.getItem(`room:${roomId}:history`);
  let roomHistory: RoomHistory;

  if (saved) {
    try {
      const data = JSON.parse(saved);
      if (Array.isArray(data)) {
        roomHistory = { roomId, teamName, createdAt: new Date().toISOString(), votingHistory };
      } else {
        roomHistory = { ...data, votingHistory, teamName };
      }
    } catch {
      roomHistory = { roomId, teamName, createdAt: new Date().toISOString(), votingHistory };
    }
  } else {
    roomHistory = { roomId, teamName, createdAt: new Date().toISOString(), votingHistory };
  }

  localStorage.setItem(`room:${roomId}:history`, JSON.stringify(roomHistory));
}
