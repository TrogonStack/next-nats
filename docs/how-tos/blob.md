# Store and serve blobs

Replace `@vercel/blob` with a NATS Object Store bucket. Change the import to `@trogonstack/next-nats/blob`, and `@vercel/blob/client` to `@trogonstack/next-nats/blob/client`.

## Mount the route

```ts
// app/blob/[...path]/route.ts
import { connection } from "next/server";
import { createBlobRoute } from "@trogonstack/next-nats/blob";

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
export async function POST(...args: Parameters<typeof route.POST>) {
  await connection();
  return route.POST(...args);
}
export async function DELETE(...args: Parameters<typeof route.DELETE>) {
  await connection();
  return route.DELETE(...args);
}
```

Pass `authorize` to `createBlobRoute` to decide who may read private blobs, delete or create folders without a signed token.

## Upload and read on the server

```ts
import { put, get, del } from "@trogonstack/next-nats/blob";

const { pathname } = await put("avatars/ada.png", file, { access: "public" });
const blob = await get(pathname, { access: "public" });
await del(pathname);
```

Pass `multipart: true` for large bodies.

## Upload from the browser

Add a handler that issues client tokens.

```ts
// app/api/blob/upload/route.ts
import { NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@trogonstack/next-nats/blob/client";

export async function POST(request: Request) {
  const body = (await request.json()) as HandleUploadBody;
  const json = await handleUpload({
    request,
    body,
    onBeforeGenerateToken: async () => ({ addRandomSuffix: true, maximumSizeInBytes: 256 * 1024 * 1024 }),
    onUploadCompleted: async ({ blob }) => console.info(blob.pathname),
  });
  return NextResponse.json(json);
}
```

Then call `upload` in a client component.

```ts
import { upload } from "@trogonstack/next-nats/blob/client";

const blob = await upload(file.name, file, { access: "public", handleUploadUrl: "/api/blob/upload" });
```

The browser holds a signed token, never NATS credentials.

## Configure the deployment

- Set `BLOB_SECRET` (or `BLOB_READ_WRITE_TOKEN`) to the same value on every replica so tokens verify everywhere.
- Set `NEXT_PUBLIC_BLOB_BASE_URL` to the absolute URL of the route when blob URLs must be absolute, for example `https://app.example.com/blob`.
- Set `NEXT_NATS_BLOB_BUCKET`, or call `configureBlob`, to choose the bucket.
