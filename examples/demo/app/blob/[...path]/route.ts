import { createBlobRoute } from "next-nats/blob";

export const dynamic = "force-dynamic";

export const { GET, HEAD, PUT } = createBlobRoute();
