import { describe, expect, expectTypeOf, it } from "vitest";
import * as realServer from "@vercel/blob";
import * as realClient from "@vercel/blob/client";
import * as ours from "../../src/blob/index.js";
import * as oursClient from "../../src/blob/client.js";

type Args<F extends (...args: never[]) => unknown> = Parameters<F>;
type Result<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>;

describe("@vercel/blob export surface", () => {
  it("exports every runtime name of the server entry", () => {
    expect(Object.keys(ours)).toEqual(expect.arrayContaining(Object.keys(realServer)));
  });

  it("exports every runtime name of the client entry", () => {
    expect(Object.keys(oursClient)).toEqual(expect.arrayContaining(Object.keys(realClient)));
  });

  it("throws errors with the same names and messages", () => {
    const pairs: Array<[new (...args: never[]) => Error, new (...args: never[]) => Error, unknown[]]> = [
      [realServer.BlobAccessError, ours.BlobAccessError, []],
      [realServer.BlobContentTypeNotAllowedError, ours.BlobContentTypeNotAllowedError, ["image/png is not allowed"]],
      [realServer.BlobPathnameMismatchError, ours.BlobPathnameMismatchError, ["tried to put a"]],
      [realServer.BlobClientTokenExpiredError, ours.BlobClientTokenExpiredError, []],
      [realServer.BlobFileTooLargeError, ours.BlobFileTooLargeError, ["max 10 bytes"]],
      [realServer.BlobStoreNotFoundError, ours.BlobStoreNotFoundError, []],
      [realServer.BlobStoreSuspendedError, ours.BlobStoreSuspendedError, []],
      [realServer.BlobUnknownError, ours.BlobUnknownError, []],
      [realServer.BlobNotFoundError, ours.BlobNotFoundError, []],
      [realServer.BlobServiceNotAvailable, ours.BlobServiceNotAvailable, []],
      [realServer.BlobServiceRateLimited, ours.BlobServiceRateLimited, [7]],
      [realServer.BlobRequestAbortedError, ours.BlobRequestAbortedError, []],
      [realServer.BlobPreconditionFailedError, ours.BlobPreconditionFailedError, []],
    ];
    for (const [Real, Ours, args] of pairs) {
      const expected = new Real(...(args as never[]));
      const actual = new Ours(...(args as never[]));
      expect(actual.name).toBe(expected.name);
      expect(actual.message).toBe(expected.message);
      expect(actual).toBeInstanceOf(ours.BlobError);
      expect(actual).toBeInstanceOf(Error);
    }
    expect(new ours.BlobServiceRateLimited(7).retryAfter).toBe(new realServer.BlobServiceRateLimited(7).retryAfter);
    expect(new ours.BlobError("x").message).toBe(new realServer.BlobError("x").message);
  });

  it("builds download urls like the real package", () => {
    const url = "https://example.com/blob/a.txt";
    expect(ours.getDownloadUrl(url)).toBe(realServer.getDownloadUrl(url));
  });

  it("matches the server command signatures", () => {
    expectTypeOf<Args<typeof realServer.put>>().toExtend<Args<typeof ours.put>>();
    expectTypeOf<Result<typeof ours.put>>().toEqualTypeOf<Result<typeof realServer.put>>();

    expectTypeOf<Args<typeof realServer.head>>().toExtend<Args<typeof ours.head>>();
    expectTypeOf<Result<typeof ours.head>>().toEqualTypeOf<Result<typeof realServer.head>>();

    expectTypeOf<Args<typeof realServer.get>>().toExtend<Args<typeof ours.get>>();
    expectTypeOf<Args<typeof ours.get>>().toExtend<Args<typeof realServer.get>>();

    expectTypeOf<Args<typeof realServer.del>>().toExtend<Args<typeof ours.del>>();
    expectTypeOf<Result<typeof ours.del>>().toEqualTypeOf<void>();

    expectTypeOf<Args<typeof realServer.copy>>().toExtend<Args<typeof ours.copy>>();
    expectTypeOf<Result<typeof ours.copy>>().toEqualTypeOf<Result<typeof realServer.copy>>();

    expectTypeOf<Args<typeof realServer.rename>>().toExtend<Args<typeof ours.rename>>();
    expectTypeOf<Result<typeof ours.rename>>().toEqualTypeOf<Result<typeof realServer.rename>>();

    expectTypeOf<Args<typeof realServer.createFolder>>().toExtend<Args<typeof ours.createFolder>>();
    expectTypeOf<Result<typeof ours.createFolder>>().toEqualTypeOf<Result<typeof realServer.createFolder>>();

    expectTypeOf<Args<typeof realServer.putImage>>().toExtend<Args<typeof ours.putImage>>();
    expectTypeOf<Args<typeof realServer.putFromUrl>>().toExtend<Args<typeof ours.putFromUrl>>();
  });

  it("matches list generics and results", async () => {
    expectTypeOf<Args<typeof realServer.list>>().toExtend<Args<typeof ours.list>>();
    type OursFolded = Awaited<ReturnType<typeof ours.list<"folded">>>;
    type RealFolded = Awaited<ReturnType<typeof realServer.list<"folded">>>;
    expectTypeOf<OursFolded>().toEqualTypeOf<RealFolded>();
    type OursExpanded = Awaited<ReturnType<typeof ours.list<"expanded">>>;
    type RealExpanded = Awaited<ReturnType<typeof realServer.list<"expanded">>>;
    expectTypeOf<OursExpanded>().toEqualTypeOf<RealExpanded>();
    expectTypeOf<ours.ListCommandOptions<"folded">>().toEqualTypeOf<realServer.ListCommandOptions<"folded">>();
  });

  it("matches the multipart signatures", () => {
    expectTypeOf<Args<typeof realServer.createMultipartUpload>>().toExtend<Args<typeof ours.createMultipartUpload>>();
    expectTypeOf<Result<typeof ours.createMultipartUpload>>().toEqualTypeOf<Result<typeof realServer.createMultipartUpload>>();
    expectTypeOf<Args<typeof realServer.uploadPart>>().toExtend<Args<typeof ours.uploadPart>>();
    expectTypeOf<Result<typeof ours.uploadPart>>().toEqualTypeOf<Result<typeof realServer.uploadPart>>();
    expectTypeOf<Args<typeof realServer.completeMultipartUpload>>().toExtend<Args<typeof ours.completeMultipartUpload>>();
    expectTypeOf<Result<typeof ours.completeMultipartUpload>>().toEqualTypeOf<Result<typeof realServer.completeMultipartUpload>>();
    expectTypeOf<Args<typeof realServer.createMultipartUploader>>().toExtend<Args<typeof ours.createMultipartUploader>>();
    expectTypeOf<Result<typeof ours.createMultipartUploader>>().toExtend<Result<typeof realServer.createMultipartUploader>>();
  });

  it("matches the presign signatures", () => {
    expectTypeOf<Args<typeof realServer.issueSignedToken>>().toExtend<Args<typeof ours.issueSignedToken>>();
    expectTypeOf<Result<typeof ours.issueSignedToken>>().toEqualTypeOf<Result<typeof realServer.issueSignedToken>>();
    expectTypeOf<Args<typeof realServer.presignUrl>>().toExtend<Args<typeof ours.presignUrl>>();
    expectTypeOf<Result<typeof ours.presignUrl>>().toEqualTypeOf<Result<typeof realServer.presignUrl>>();
    expectTypeOf<Args<typeof realServer.parseStoreIdFromDelegationToken>>().toEqualTypeOf<Args<typeof ours.parseStoreIdFromDelegationToken>>();
    expectTypeOf<Args<typeof realServer.parseStoreIdFromPresignedUrl>>().toExtend<Args<typeof ours.parseStoreIdFromPresignedUrl>>();
  });

  it("matches the client signatures", () => {
    expectTypeOf<Args<typeof realClient.put>>().toExtend<Args<typeof oursClient.put>>();
    expectTypeOf<Result<typeof oursClient.put>>().toEqualTypeOf<Result<typeof realClient.put>>();
    expectTypeOf<Args<typeof realClient.upload>>().toExtend<Args<typeof oursClient.upload>>();
    expectTypeOf<Args<typeof realClient.uploadPresigned>>().toExtend<Args<typeof oursClient.uploadPresigned>>();
    expectTypeOf<Args<typeof realClient.createMultipartUpload>>().toExtend<Args<typeof oursClient.createMultipartUpload>>();
    expectTypeOf<Args<typeof realClient.uploadPart>>().toExtend<Args<typeof oursClient.uploadPart>>();
    expectTypeOf<Args<typeof realClient.completeMultipartUpload>>().toExtend<Args<typeof oursClient.completeMultipartUpload>>();
    expectTypeOf<Result<typeof oursClient.createMultipartUploader>>().toExtend<Result<typeof realClient.createMultipartUploader>>();
    expectTypeOf<Args<typeof realClient.createFolder>>().toExtend<Args<typeof oursClient.createFolder>>();
    expectTypeOf<Args<typeof realClient.generateClientTokenFromReadWriteToken>>().toEqualTypeOf<
      Args<typeof oursClient.generateClientTokenFromReadWriteToken>
    >();
    expectTypeOf<Result<typeof oursClient.generateClientTokenFromReadWriteToken>>().toEqualTypeOf<string>();
    expectTypeOf<Args<typeof realClient.getPayloadFromClientToken>>().toEqualTypeOf<Args<typeof oursClient.getPayloadFromClientToken>>();
    expectTypeOf<ReturnType<typeof oursClient.getPayloadFromClientToken>>().toEqualTypeOf<
      ReturnType<typeof realClient.getPayloadFromClientToken>
    >();
  });

  it("matches the handleUpload contracts", () => {
    expectTypeOf<Args<typeof realClient.handleUpload>>().toExtend<Args<typeof oursClient.handleUpload>>();
    expectTypeOf<Result<typeof oursClient.handleUpload>>().toEqualTypeOf<Result<typeof realClient.handleUpload>>();
    expectTypeOf<Args<typeof realClient.handleUploadPresigned>>().toExtend<Args<typeof oursClient.handleUploadPresigned>>();
    expectTypeOf<Result<typeof oursClient.handleUploadPresigned>>().toEqualTypeOf<Result<typeof realClient.handleUploadPresigned>>();
    expectTypeOf<oursClient.HandleUploadBody>().toEqualTypeOf<realClient.HandleUploadBody>();
    expectTypeOf<oursClient.UploadOptions>().toEqualTypeOf<realClient.UploadOptions>();
  });
});
