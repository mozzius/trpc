import { createAppRouter } from './__testHelpers';
import '@testing-library/jest-dom';
import {
  createProxySSGHelpers,
  createServerSideHelpers,
} from '@trpc/react-query/src/ssg';

let factory: ReturnType<typeof createAppRouter>;
beforeEach(() => {
  factory = createAppRouter();
});
afterEach(async () => {
  await factory.close();
});

test('dehydrate', async () => {
  const { db, appRouter } = factory;
  const ssg = createServerSideHelpers({ router: appRouter, ctx: {} });

  await ssg.allPosts.prefetch();
  await ssg.postById.prefetch('1');

  const dehydrated = ssg.dehydrate().queries;
  expect(dehydrated).toHaveLength(2);

  const [cache, cache2] = dehydrated;
  expect(cache.queryHash).toMatchInlineSnapshot(
    `"[[\\"allPosts\\"],{\\"type\\":\\"query\\"}]"`,
  );
  expect(cache.queryKey).toMatchInlineSnapshot(`
    Array [
      Array [
        "allPosts",
      ],
      Object {
        "type": "query",
      },
    ]
  `);
  expect(cache.state.data).toEqual(db.posts);
  expect(cache2.state.data).toMatchInlineSnapshot(`
    Object {
      "createdAt": 0,
      "id": "1",
      "title": "first post",
    }
  `);
});

test('deprecated alias', async () => {
  const { db, appRouter } = factory;
  const ssg = createProxySSGHelpers({ router: appRouter, ctx: {} });

  await ssg.allPosts.prefetch();
  await ssg.postById.prefetch('1');

  const dehydrated = ssg.dehydrate().queries;
  expect(dehydrated).toHaveLength(2);

  const [cache, cache2] = dehydrated;
  expect(cache.queryHash).toMatchInlineSnapshot(
    `"[[\\"allPosts\\"],{\\"type\\":\\"query\\"}]"`,
  );
  expect(cache.queryKey).toMatchInlineSnapshot(`
    Array [
      Array [
        "allPosts",
      ],
      Object {
        "type": "query",
      },
    ]
  `);
  expect(cache.state.data).toEqual(db.posts);
  expect(cache2.state.data).toMatchInlineSnapshot(`
    Object {
      "createdAt": 0,
      "id": "1",
      "title": "first post",
    }
  `);
});
