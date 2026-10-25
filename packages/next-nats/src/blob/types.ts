import type { Readable } from "node:stream";

export type BlobAccessType = "public" | "private";

export interface BlobCommandOptions {
  token?: string;
  oidcToken?: string;
  storeId?: string;
  abortSignal?: AbortSignal;
}

export interface CommonCreateBlobOptions extends BlobCommandOptions {
  access: BlobAccessType;
  addRandomSuffix?: boolean;
  allowOverwrite?: boolean;
  contentType?: string;
  cacheControlMaxAge?: number;
  ifMatch?: string;
  maximumSizeInBytes?: number;
}

export interface UploadProgressEvent {
  loaded: number;
  total: number;
  percentage: number;
}

export type OnUploadProgressCallback = (progressEvent: UploadProgressEvent) => void;

export interface WithUploadProgress {
  onUploadProgress?: OnUploadProgressCallback;
}

export interface OptimizeImageOptions {
  width: number;
  quality?: number;
  format?: "jpeg" | "png" | "webp" | "avif";
}

export interface PutBlobResult {
  url: string;
  downloadUrl: string;
  pathname: string;
  contentType: string;
  contentDisposition: string;
  etag: string;
}

export interface FileLike {
  readonly name: string;
  readonly lastModified: number;
  readonly size: number;
  readonly type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
  stream(): unknown;
}

export type PutBody = string | Readable | Buffer | Blob | ArrayBuffer | ArrayBufferView | ReadableStream | FileLike;

export interface PartInput {
  partNumber: number;
  blob: PutBody;
}

export interface Part {
  etag: string;
  partNumber: number;
}

export interface BlobClientTokenConstraintOptions {
  maximumSizeInBytes?: number;
  allowedContentTypes?: string[];
  validUntil?: number;
  addRandomSuffix?: boolean;
  allowOverwrite?: boolean;
  cacheControlMaxAge?: number;
  ifMatch?: string;
  onUploadCompleted?: {
    callbackUrl: string;
    tokenPayload?: string | null;
  };
}

export interface CommonCompleteMultipartUploadOptions {
  uploadId: string;
  key: string;
}

export type CompleteMultipartUploadCommandOptions = CommonCompleteMultipartUploadOptions & CommonCreateBlobOptions;

export interface CommonMultipartUploadOptions {
  uploadId: string;
  key: string;
  partNumber: number;
}

export type UploadPartCommandOptions = CommonMultipartUploadOptions & CommonCreateBlobOptions;

export interface PresignedUrlPayload {
  delegationToken: string;
  signature: string;
  params: Record<string, string>;
}

export type DelegationOperation = "get" | "head" | "put" | "delete";

export interface IssuedSignedToken {
  delegationToken: string;
  clientSigningToken: string;
  validUntil: number;
}

export type IssueSignedTokenOptions = BlobCommandOptions & {
  pathname?: string;
  operations?: DelegationOperation[];
  validUntil?: number;
  allowedContentTypes?: string[];
  maximumSizeInBytes?: number;
};

export type PresignGetUrlOptions = { operation: "get"; pathname: string; validUntil?: number; useCache?: boolean };
export type PresignHeadUrlOptions = { operation: "head"; pathname: string; validUntil?: number };
export type PresignPutUrlOptions = {
  operation: "put";
  pathname: string;
  validUntil?: number;
  allowedContentTypes?: string[];
  maximumSizeInBytes?: number;
  onUploadCompleted?: { callbackUrl: string; tokenPayload?: string };
  allowOverwrite?: boolean;
  addRandomSuffix?: boolean;
  cacheControlMaxAge?: number;
  ifMatch?: string;
};
export type PresignDeleteUrlOptions = { operation: "delete"; pathname: string; validUntil?: number; ifMatch?: string };
export type PresignUrlOptions = PresignGetUrlOptions | PresignHeadUrlOptions | PresignPutUrlOptions | PresignDeleteUrlOptions;
export type PresignUrlResult = { presignedUrl: string };

export type CreateFolderCommandOptions = Pick<CommonCreateBlobOptions, "token" | "abortSignal"> & { access?: BlobAccessType };

export interface CreateFolderResult {
  pathname: string;
  url: string;
}

export interface GenerateClientTokenOptions extends BlobCommandOptions, BlobClientTokenConstraintOptions {
  pathname: string;
}

export type DecodedClientTokenPayload = Omit<GenerateClientTokenOptions, "token"> & { validUntil: number };
