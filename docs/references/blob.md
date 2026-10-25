# Blob

Exports of `@trogonstack/next-nats/blob` (server) and `@trogonstack/next-nats/blob/client` (browser safe). Names, signatures, option names and result types follow `@vercel/blob`, and a parity test checks them against the real package.

## Server commands

| Export | Description |
| --- | --- |
| `put(pathname, body, options)` | Store a body. `multipart: true` stages 8 MB parts and assembles them |
| `head(urlOrPathname, options?)` | Size, upload time, content type, etag |
| `get(urlOrPathname, options)` | `{ statusCode, stream, headers, blob }` or `null` when missing or when `access` does not match. `ifNoneMatch` yields a 304 result |
| `del(urlOrPathname or list, options?)` | Delete, optionally guarded by `ifMatch` |
| `list(options?)` | Expanded or folded listing |
| `copy(from, to, options)` | Copy a blob |
| `rename(from, to, options)` | Copy then delete the source |
| `createFolder(pathname, options?)` | Stores a zero-byte `pathname/` object |
| `createMultipartUpload`, `uploadPart`, `completeMultipartUpload`, `createMultipartUploader` | Manual multipart. Parts are staged in the `<bucket>_mpu` bucket for 24 hours |
| `getDownloadUrl(url)` | URL with `?download=1` |
| `issueSignedToken`, `presignUrl`, `parseStoreIdFromDelegationToken`, `parseStoreIdFromPresignedUrl` | Delegation tokens and presigned URLs. The store id is the bucket name |
| `putImage`, `putFromUrl` | Exist for import parity and throw `BlobError` |

Additional exports: `getBlobStore`, `blobUrl`, `blobDownloadUrl`, `resolvePathname`, `configureBlob`, `getBlobConfig`, `createBlobRoute`, `parseRange`, `blobErrorFromResponse`, `BlobAlreadyExistsError`.

## Client commands

Exports of `@trogonstack/next-nats/blob/client`: `put`, `upload`, `uploadPresigned`, `createMultipartUpload`, `createMultipartUploader`, `uploadPart`, `completeMultipartUpload`, `createFolder`, `handleUpload`, `handleUploadPresigned`, `generateClientTokenFromReadWriteToken`, `getPayloadFromClientToken`, `EventTypes` and their option and event types.

`handleUpload` and `handleUploadPresigned` run on your server and are exported from the client entry as in `@vercel/blob/client`. The entry imports no `server-only` or Node modules.

## Route

`createBlobRoute(options?)` returns `GET`, `HEAD`, `PUT`, `POST` and `DELETE` handlers for a catch-all route.

| Request | Meaning |
| --- | --- |
| `GET`, `HEAD` `/<pathname>` | Read, byte ranges and conditional requests. Private blobs need a signature or `authorize` |
| `PUT` `/<pathname>` | Single upload. Content type from `x-content-type` or `content-type`, access from `x-blob-access` |
| `PUT` `/<pathname>?mpu=part&uploadId&key&partNumber` | Upload one part |
| `POST` `?mpu=create`, `?mpu=complete` | Start or finish a multipart upload |
| `POST` `?action=create-folder` | Create a folder, needs `authorize` |
| `DELETE` `/<pathname>` | Delete, needs a signed token or `authorize` |

A request is allowed with `Authorization: Bearer <client token>` (or `?token=`), presigned query parameters, or when `options.authorize(request, pathname)` resolves true. The upload-completed callback is a fire-and-forget `POST` signed in the `x-blob-signature` header.

## Environment

| Variable | Meaning | Default |
| --- | --- | --- |
| `BLOB_BASE_URL`, `NEXT_PUBLIC_BLOB_BASE_URL` | Where the route is mounted. Blob URLs and client uploads start here | `/blob` |
| `BLOB_SECRET` | HMAC secret for client tokens, presigned URLs and callbacks. Accepts the Secret Value Syntax | Random per process |
| `BLOB_READ_WRITE_TOKEN` | Used as the signing secret when `BLOB_SECRET` is unset | none |
| `NEXT_NATS_BLOB_BUCKET` | Object Store bucket | `next_nats_blob` |

Set a stable secret when more than one replica serves the route, otherwise tokens signed by one replica fail on another.

## Token semantics

The `token`, `oidcToken` and `storeId` options are accepted so call sites compile, and server calls ignore them because they talk to NATS in process. Client tokens have the form `blob_client_<payload>.<signature>` and carry `pathname`, `validUntil`, `maximumSizeInBytes`, `allowedContentTypes`, `addRandomSuffix`, `allowOverwrite`, `callbackUrl` and `access`. `generateClientTokenFromReadWriteToken` signs with the configured secret and ignores its `token` argument.

## Errors

`BlobError` and the subclasses of `@vercel/blob`: `BlobAccessError`, `BlobContentTypeNotAllowedError`, `BlobPathnameMismatchError`, `BlobClientTokenExpiredError`, `BlobFileTooLargeError`, `BlobStoreNotFoundError`, `BlobStoreSuspendedError`, `BlobUnknownError`, `BlobNotFoundError`, `BlobServiceNotAvailable`, `BlobServiceRateLimited`, `BlobRequestAbortedError`, `BlobPreconditionFailedError`. Messages match the real package. `name` is the class name.
