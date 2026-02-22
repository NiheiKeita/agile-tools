// P2P メッセージ（グループ内でクライアント間で直接やり取り）
export type PeerMessage =
  | { type: 'join'; userId: string; nickname: string; isHost?: boolean }
  | { type: 'leave'; userId: string }
  | { type: 'vote'; userId: string; value: string }
  | { type: 'reveal'; userId: string }
  | { type: 'reset'; userId: string }
  | { type: 'setStory'; userId: string; story: string; storyUrl?: string }
  | { type: 'heartbeat'; userId: string; nickname: string }
  | { type: 'syncResponse'; targetUserId: string; state: RoomState };

export interface RoomState {
  roomId: string;
  story: string | null;
  storyUrl: string | null;
  participants: Participant[];
  votes: Record<string, string>; // userId -> カード値（公開後のみ同期）
  isRevealed: boolean;
  facilitatorId: string;
}

export interface Participant {
  id: string;
  nickname: string;
  hasVoted: boolean;
}

export interface UserInfo {
  userId: string;
  nickname: string;
}

export interface VoteRecord {
  id: string;
  sessionId: string;
  story: string;
  myVote: string;
  finalEstimate: string;
  participants: number;
  votedAt: Date;
}

export interface VotingHistoryItem {
  id: string;
  story: string;
  storyUrl?: string;
  votes: Record<string, string>; // userId -> vote value
  participantNames: Record<string, string>; // userId -> nickname
  estimate?: string;
  votedAt: string; // ISO timestamp
}

export interface RoomHistory {
  roomId: string;
  teamName?: string;
  createdAt: string; // ISO timestamp
  votingHistory: VotingHistoryItem[];
}
