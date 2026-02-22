'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PeerMessage } from '@/types';

interface UseWebPubSubOptions {
  roomId: string;
  userId: string;
  nickname: string;
  isHost: boolean;
  onMessage: (message: PeerMessage) => void;
  enabled?: boolean;
}

const HEARTBEAT_INTERVAL = 5000; // 5秒

export function useWebPubSub({
  roomId,
  userId,
  nickname,
  isHost,
  onMessage,
  enabled = true,
}: UseWebPubSubOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const onMessageRef = useRef(onMessage);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  const send = useCallback((message: PeerMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'sendToGroup',
        group: roomId,
        noEcho: true,
        dataType: 'json',
        data: message,
      }));
    }
  }, [roomId]);

  const connect = useCallback(async () => {
    if (!enabled || !userId) return;

    try {
      const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || '/api';
      const res = await fetch(`${apiBaseUrl}/negotiate?roomId=${roomId}&userId=${userId}`);
      if (!res.ok) throw new Error('Failed to negotiate');
      const { url } = await res.json();

      const ws = new WebSocket(url, 'json.webpubsub.azure.v1');
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[WS] Connected');
        setIsConnected(true);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'joinGroup',
            group: roomId,
            ackId: 1,
          }));
        }
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          // joinGroup の ack → グループに join を送信 & heartbeat 開始
          if (data.type === 'ack' && data.ackId === 1) {
            if (data.success && ws.readyState === WebSocket.OPEN) {
              const joinMsg: PeerMessage = { type: 'join', userId, nickname, isHost };
              ws.send(JSON.stringify({
                type: 'sendToGroup',
                group: roomId,
                noEcho: true,
                dataType: 'json',
                data: joinMsg,
              }));

              // heartbeat 開始
              if (heartbeatRef.current) clearInterval(heartbeatRef.current);
              heartbeatRef.current = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({
                    type: 'sendToGroup',
                    group: roomId,
                    noEcho: true,
                    dataType: 'json',
                    data: { type: 'heartbeat', userId, nickname } satisfies PeerMessage,
                  }));
                }
              }, HEARTBEAT_INTERVAL);
            }
          }

          // グループメッセージ（他のクライアントから）
          if (data.type === 'message' && data.from === 'group') {
            onMessageRef.current(data.data);
          }
        } catch (e) {
          console.error('Failed to parse message:', e);
        }
      };

      ws.onerror = () => setError(new Error('WebSocket error'));

      ws.onclose = () => {
        setIsConnected(false);
        if (heartbeatRef.current) {
          clearInterval(heartbeatRef.current);
          heartbeatRef.current = null;
        }
      };
    } catch (e) {
      setError(e instanceof Error ? e : new Error('Unknown error'));
    }
  }, [roomId, userId, nickname, isHost, enabled]);

  const disconnect = useCallback(() => {
    if (userId && wsRef.current?.readyState === WebSocket.OPEN) {
      send({ type: 'leave', userId });
    }
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
    wsRef.current?.close();
  }, [send, userId]);

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  return { isConnected, error, send };
}
