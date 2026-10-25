# Blob

Exports of `@trogonstack/next-nats/blob`. The shapes follow `@vercel/blob`.

## Commands

| Export | Description |
| --- | --- |
| `put(pathname, body, options)` | Store a body. Options: `access`, `addRandomSuffix`, `allowOverwrite`, `contentType`, `cacheControlMaxAge`, `ifMatch`, `maximumSizeInBytes`, `multipart`, `onUploadProgress`, `token`, `abortSignal` |
| `head(urlOrPathname)` | Size, upload time, content type and etag |
| `get(urlOrPathname, options?)` | Stream and metadata, or `null` when missing |
| `del(urlOrPathname or list, options?)` | Delete, optionally guarded by `ifMatch` |
| `list(options?)` | Expanded or folded listing |
| `copy(from, to, options)` | Copy a blob |
| `rename(from, to, options)` | Copy then delete the source |
| `getBlobStore(bucket?)` | The underlying Object Store |
| `blobUrl`, `blobDownloadUrl`, `resolvePathname` | URL helpers |

## Signed access

| Export | Description |
| --- | --- |
| `createUploadUrl(pathname, options?)` | `{ url, token, expiresAt }` for a `put` |
| `createSignedUrl(pathname, options?)` | URL with a `get` token |
| `signBlobToken`, `signedBlobToken`, `verifyBlobToken` | Token primitives. Tokens are HMAC signed and expire, one hour by default |

Upload options add `maximumSizeInBytes`, `allowedContentTypes`, `addRandomSuffix` and `allowOverwrite`.

## Route

`createBlobRoute(options?)` returns `GET`, `HEAD` and `PUT` handlers. A request is allowed with a valid token for that path and operation, or when `options.authorize(request, pathname)` resolves true. `parseRange` parses a `Range` header.

## Configuration

`configureBlob` and `getBlobConfig` set and read the bucket. `NEXT_NATS_BLOB_BUCKET` selects the bucket from the environment.

## Errors

`BlobError` and its subclasses, including `BlobNotFoundError`, `BlobPreconditionFailedError`, `BlobAccessError` and `BlobClientTokenExpiredError`.
