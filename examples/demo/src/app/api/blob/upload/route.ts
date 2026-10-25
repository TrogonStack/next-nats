import { connection, NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@trogonstack/next-nats/blob/client";

export async function POST(request: Request) {
  await connection();
  const body = (await request.json()) as HandleUploadBody;
  try {
    const json = await handleUpload({
      request,
      body,
      onBeforeGenerateToken: async () => ({
        addRandomSuffix: true,
        maximumSizeInBytes: 256 * 1024 * 1024,
      }),
      onUploadCompleted: async ({ blob }) => {
        console.info("blob upload completed", blob.pathname);
      },
    });
    return NextResponse.json(json);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
