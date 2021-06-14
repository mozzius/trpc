/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/ban-types */
// import WebSocket from 'ws';
import { waitFor } from '@testing-library/react';
import { EventEmitter } from 'events';
// import { expectTypeOf } from 'expect-type';
import ws from 'ws';
import { z } from 'zod';
import {
  createWSClient,
  TRPCWebSocketClient,
  WebSocketInterruptedError,
  wsLink,
} from '../../client/src/links/wsLink';
import * as trpc from '../src';
import { applyWSSHandler } from '../src/ws';
import { routerToServerAndClient } from './_testHelpers';

function factory() {
  const ee = new EventEmitter();
  type Message = {
    id: string;
  };
  const subRef: {
    current: trpc.Subscription<Message>;
  } = {} as any;
  let wsClient: TRPCWebSocketClient = null as any;
  const onNewMessageSubscription = jest.fn();
  const subscriptionEnded = jest.fn();
  const opts = routerToServerAndClient(
    trpc
      .router()
      .query('greeting', {
        input: z.string().nullish(),
        resolve({ input }) {
          return `hello ${input ?? 'world'}`;
        },
      })
      .mutation('posts.edit', {
        input: z.object({
          id: z.string(),
          data: z.object({
            title: z.string(),
            text: z.string(),
          }),
        }),
        async resolve({ input }) {
          const { id, data } = input;
          return {
            id,
            ...data,
          };
        },
      })
      .subscription('onMessage', {
        input: z.string().optional(),
        resolve() {
          const sub = (subRef.current = new trpc.Subscription<Message>({
            start(emit) {
              const onMessage = (data: Message) => {
                emit.data(data);
              };
              ee.on('server:msg', onMessage);
              return () => {
                subscriptionEnded();
                ee.off('server:msg', onMessage);
              };
            },
          }));
          ee.emit('subscription:created');
          onNewMessageSubscription();
          return sub;
        },
      }),
    {
      client({ wssUrl }) {
        wsClient = createWSClient({
          url: wssUrl,
          retryDelayMs: () => 0,
          staleConnectionTimeoutMs: 0,
        });
        return {
          links: [wsLink({ client: wsClient })],
        };
      },
    },
  );

  return {
    ee,
    wsClient,
    ...opts,
    subRef,
    onNewMessageSubscription,
  };
}

test('query', async () => {
  const { client, close, wsClient } = factory();
  expect(await client.query('greeting')).toBe('hello world');
  expect(await client.query('greeting', null)).toBe('hello world');
  expect(await client.query('greeting', 'alexdotjs')).toBe('hello alexdotjs');

  close();
  wsClient.close();
});

test('mutation', async () => {
  const { client, close, wsClient } = factory();
  expect(
    await client.mutation('posts.edit', {
      id: 'id',
      data: { title: 'title', text: 'text' },
    }),
  ).toMatchInlineSnapshot(`
    Object {
      "id": "id",
      "text": "text",
      "title": "title",
    }
  `);

  close();
  wsClient.close();
});

test('subscriptionOnce()', async () => {
  const { client, close, wsClient, ee } = factory();
  ee.once('subscription:created', () => {
    setImmediate(() => {
      ee.emit('server:msg', {
        id: '1',
      });
    });
  });
  const msgs = await client.subscriptionOnce('onMessage', '');

  expect(msgs).toMatchInlineSnapshot(`
    Object {
      "id": "1",
    }
  `);

  await waitFor(() => {
    expect(ee.listenerCount('server:msg')).toBe(0);
    expect(ee.listenerCount('server:error')).toBe(0);
  });
  close();
  wsClient.close();
});

test('$subscription()', async () => {
  const { client, close, ee, wsClient } = factory();
  ee.once('subscription:created', () => {
    setImmediate(() => {
      ee.emit('server:msg', {
        id: '1',
      });
      ee.emit('server:msg', {
        id: '2',
      });
    });
  });
  const onNext = jest.fn();
  const unsub = client.$subscription('onMessage', undefined, {
    onNext,
  });

  await waitFor(() => {
    expect(onNext).toHaveBeenCalledTimes(2);
  });

  ee.emit('server:msg', {
    id: '2',
  });
  await waitFor(() => {
    expect(onNext).toHaveBeenCalledTimes(3);
  });

  expect(onNext.mock.calls).toMatchInlineSnapshot(`
    Array [
      Array [
        Object {
          "id": "1",
        },
      ],
      Array [
        Object {
          "id": "2",
        },
      ],
      Array [
        Object {
          "id": "2",
        },
      ],
    ]
  `);

  unsub();
  await waitFor(() => {
    expect(ee.listenerCount('server:msg')).toBe(0);
    expect(ee.listenerCount('server:error')).toBe(0);
  });
  close();
  wsClient.close();
});

test('$subscription() - server randomly stop and restart', async () => {
  const { client, close, wsClient, ee, wssPort, applyWSSHandlerOpts } =
    factory();
  ee.once('subscription:created', () => {
    setImmediate(() => {
      ee.emit('server:msg', {
        id: '1',
      });
      ee.emit('server:msg', {
        id: '2',
      });
    });
  });
  const onNext = jest.fn();
  const onError = jest.fn();
  const onDone = jest.fn();
  client.$subscription('onMessage', undefined, {
    onNext,
    onError,
    onDone,
  });

  await waitFor(() => {
    expect(onNext).toHaveBeenCalledTimes(2);
  });
  // close websocket
  close();
  await waitFor(() => {
    expect(onError).toHaveBeenCalledTimes(1);
  });
  expect(onError.mock.calls[0][0]).toMatchInlineSnapshot(
    `[Error: Operation ended prematurely]`,
  );
  expect(onError.mock.calls[0][0].originalError).toBeInstanceOf(
    WebSocketInterruptedError,
  );

  // reconnect from client
  ee.once('subscription:created', () => {
    setTimeout(() => {
      ee.emit('server:msg', {
        id: '3',
      });
    }, 1);
  });
  client.$subscription('onMessage', undefined, {
    onNext,
    onError,
    onDone,
  });

  // start a new wss server on same port, and trigger a message
  onNext.mockClear();
  onDone.mockClear();

  const wss = new ws.Server({ port: wssPort });
  applyWSSHandler({ ...applyWSSHandlerOpts, wss });
  await waitFor(() => {
    expect(onNext).toHaveBeenCalledTimes(1);
  });
  expect(onNext.mock.calls).toMatchInlineSnapshot(`
    Array [
      Array [
        Object {
          "id": "3",
        },
      ],
    ]
  `);

  wsClient.close();
  wss.close();
});

test('server subscription ended', async () => {
  const { client, close, wsClient, ee, subRef } = factory();
  ee.once('subscription:created', () => {
    setImmediate(() => {
      ee.emit('server:msg', {
        id: '1',
      });
      ee.emit('server:msg', {
        id: '2',
      });
    });
  });
  const onNext = jest.fn();
  const onError = jest.fn();
  const onDone = jest.fn();
  client.$subscription('onMessage', undefined, {
    onNext,
    onError,
    onDone,
  });

  await waitFor(() => {
    expect(onNext).toHaveBeenCalledTimes(2);
  });
  // destroy server subscription
  subRef.current.destroy();
  await waitFor(() => {
    expect(onDone).toHaveBeenCalledTimes(1);
  });
  wsClient.close();
  close();
});

test('server emits disconnect', async () => {
  const { client, close, wsClient, wssHandler, onNewMessageSubscription, wss } =
    factory();

  const onNewClient = jest.fn();
  wss.addListener('connection', onNewClient);
  const onNext = jest.fn();
  const onError = jest.fn();
  const onDone = jest.fn();
  client.$subscription('onMessage', undefined, {
    onNext,
    onError,
    onDone,
  });

  await waitFor(() => {
    expect(onNewMessageSubscription).toHaveBeenCalledTimes(1);
    expect(onNewClient).toHaveBeenCalledTimes(1);
  });
  wssHandler.reconnectAllClients();
  await waitFor(() => {
    expect(onNewMessageSubscription).toHaveBeenCalledTimes(1);
    expect(onNewClient).toHaveBeenCalledTimes(2);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  wsClient.close();
  close();
});
