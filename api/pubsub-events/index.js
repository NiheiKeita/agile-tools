const { WebPubSubServiceClient } = require('@azure/web-pubsub');
const crypto = require('crypto');

// Azure Functions環境でcryptoをグローバルに設定
if (typeof global !== 'undefined' && !global.crypto) {
  global.crypto = crypto;
}

// インメモリでルーム状態を管理（MVPとして簡易実装）
const rooms = new Map();
const connections = new Map(); // connectionId -> { roomId, userId }

function getRoomState(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      participants: new Map(), // userId -> { nickname, hasVoted }
      votes: new Map(), // userId -> vote value
      isRevealed: false,
      facilitatorId: null,
      story: null,
      storyUrl: null,
    });
  }
  return rooms.get(roomId);
}

function serializeRoomState(roomId, roomState) {
  return {
    roomId,
    participants: Array.from(roomState.participants.entries()).map(([id, p]) => ({
      id,
      nickname: p.nickname,
      hasVoted: p.hasVoted,
    })),
    votes: roomState.isRevealed ? Object.fromEntries(roomState.votes) : {},
    isRevealed: roomState.isRevealed,
    facilitatorId: roomState.facilitatorId,
    story: roomState.story,
    storyUrl: roomState.storyUrl,
  };
}

async function broadcastRoomState(client, roomId, roomState) {
  await client.group(roomId).sendToAll({
    type: 'roomState',
    state: serializeRoomState(roomId, roomState),
  });
}

function promoteNextFacilitator(roomState) {
  const nextParticipant = roomState.participants.keys().next();
  roomState.facilitatorId = nextParticipant.done ? null : nextParticipant.value;
}

async function removeParticipant(client, roomId, userId, connectionId) {
  const roomState = rooms.get(roomId);
  if (!roomState || !roomState.participants.has(userId)) {
    connections.delete(connectionId);
    return;
  }

  roomState.participants.delete(userId);
  roomState.votes.delete(userId);

  if (roomState.facilitatorId === userId) {
    promoteNextFacilitator(roomState);
  }

  if (roomState.participants.size === 0) {
    rooms.delete(roomId);
    connections.delete(connectionId);
    return;
  }

  await client.group(roomId).sendToAll({
    type: 'userLeft',
    userId,
  });
  await broadcastRoomState(client, roomId, roomState);
  connections.delete(connectionId);
}

module.exports = async function (context, req) {
  // Web PubSub abuse protection validation
  if (req.method === 'OPTIONS') {
    const origin = req.headers['webhook-request-origin'];
    if (origin) {
      context.res = {
        status: 200,
        headers: {
          'WebHook-Allowed-Origin': origin,
          'WebHook-Allowed-Rate': '*',
        },
      };
      return;
    }
  }

  const connectionString = process.env.WEB_PUBSUB_CONNECTION_STRING;
  if (!connectionString) {
    context.res = { status: 500, body: { error: 'Configuration error' } };
    return;
  }

  const client = new WebPubSubServiceClient(connectionString, 'poker');
  const eventType = req.headers['ce-type'];
  const userId = req.headers['ce-userid'];
  const connectionId = req.headers['ce-connectionid'];

  context.log(`Event: ${eventType}, User: ${userId}`);

  // システムイベント
  if (eventType === 'azure.webpubsub.sys.connected') {
    context.log(`User ${userId} connected`);
    context.res = { status: 200 };
    return;
  }

  if (eventType === 'azure.webpubsub.sys.disconnected') {
    context.log(`User ${userId} disconnected`);
    const connection = connections.get(connectionId);
    if (connection) {
      await removeParticipant(client, connection.roomId, connection.userId, connectionId);
    }
    context.res = { status: 200 };
    return;
  }

  // ユーザーイベント
  if (eventType === 'azure.webpubsub.user.poker-event') {
    try {
      context.log('Raw request body:', req.body);
      context.log('Request body type:', typeof req.body);

      // Web PubSubはCloudEventsフォーマットでデータを送る
      // dataフィールドにJSONが文字列として格納されている可能性がある
      let message = req.body;
      if (typeof req.body === 'string') {
        message = JSON.parse(req.body);
      }
      // dataフィールドがある場合はそれを使用
      if (message.data) {
        message = typeof message.data === 'string' ? JSON.parse(message.data) : message.data;
      }

      const roomId = message.group || message.roomId;

      context.log('Parsed message:', message);
      context.log('roomId:', roomId);

      if (!roomId) {
        context.res = { status: 400, body: { error: 'roomId required' } };
        return;
      }

      const roomState = getRoomState(roomId);

      // メッセージタイプに応じた処理
      switch (message.type) {
        case 'join':
          roomState.participants.set(userId, {
            nickname: message.nickname,
            hasVoted: false,
          });
          connections.set(connectionId, { roomId, userId });

          if (!roomState.facilitatorId) {
            roomState.facilitatorId = userId;
          }

          // 参加したユーザーに現在のルーム状態を送信
          await client.sendToConnection(connectionId, {
            type: 'roomState',
            state: serializeRoomState(roomId, roomState),
          });

          // 他の参加者に参加通知（自分以外）
          await client.group(roomId).sendToAll(
            {
              type: 'userJoined',
              user: {
                id: userId,
                nickname: message.nickname,
                hasVoted: false,
              },
            },
            { filter: `userId ne '${userId}'` }
          );
          break;

        case 'leave':
          await removeParticipant(client, roomId, userId, connectionId);
          break;

        case 'vote':
          if (roomState.participants.has(userId)) {
            roomState.votes.set(userId, message.value);
            const participant = roomState.participants.get(userId);
            participant.hasVoted = true;

            // 投票済み通知（値は非公開）
            await client.group(roomId).sendToAll({
              type: 'voted',
              userId,
            });
          }
          break;

        case 'reveal':
          if (userId === roomState.facilitatorId) {
            roomState.isRevealed = true;
            const votes = Object.fromEntries(roomState.votes);

            await client.group(roomId).sendToAll({
              type: 'revealed',
              votes,
            });
          }
          break;

        case 'reset':
          if (userId === roomState.facilitatorId) {
            roomState.votes.clear();
            roomState.isRevealed = false;
            roomState.story = null;
            roomState.storyUrl = null;
            for (const participant of roomState.participants.values()) {
              participant.hasVoted = false;
            }

            await client.group(roomId).sendToAll({
              type: 'reset',
            });
          }
          break;

        case 'setStory':
          if (userId === roomState.facilitatorId) {
            roomState.story = message.story || null;
            roomState.storyUrl = message.storyUrl || null;

            await client.group(roomId).sendToAll({
              type: 'storyUpdated',
              story: roomState.story,
              storyUrl: roomState.storyUrl,
            });
          }
          break;

        default:
          context.log('Unknown message type:', message.type);
      }

      context.res = { status: 200 };
    } catch (error) {
      context.log.error('Error processing message:', error);
      context.res = { status: 500, body: { error: error.message } };
    }
    return;
  }

  context.res = { status: 200 };
};
