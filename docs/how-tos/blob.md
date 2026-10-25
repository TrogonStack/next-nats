# Store and serve blobs

Replace `@vercel/blob` with a NATS Object Store bucket.

## Mount the route

```ts
// app/blob/[...path]/route.ts
import { connection } from "next/server";
import { createBlobRoute } from "next-nats/blob";

const route = createBlobRoute();

export async function GET(...args: Parameters<typeof route.GET>) {
  await connection();
  return route.GET(...args);
}
export async function HEAD(...args: Parameters<typeof route.HEAD>) {
  await connection();
  return route.HEAD(...args);
}
export async function PUT(...args: Parameters<typeof route.PUT>) {
  await connection();
  return route.PUT(...args);
}
```

The route serves byte ranges and conditional requests. Pass `authorize` to `createBlobRoute` to decide who may read or write without a signed token.

## Upload and read on the server

```ts
import { put, get, del } from "next-nats/blob";

const { pathname } = await put("avatars/ada.png", file, { access: "public" });
const blob = await get(pathname);
await del(pathname);
```

## Hand the browser a signed URL

```ts
import { createUploadUrl, createSignedUrl } from "next-nats/blob";

const upload = createUploadUrl("avatars/ada.png");
const download = createSignedUrl("avatars/ada.png");
```

The route verifies the token, so the browser never holds NATS credentials.

## Choose the bucket

Set `NEXT_NATS_BLOB_BUCKET`, or call `configureBlob`.
