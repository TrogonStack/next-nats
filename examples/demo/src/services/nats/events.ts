import { ensureStreamOnce } from "@trogonstack/next-nats";
import { DEMO_DLQ, DEMO_STREAM, DEMO_SUBJECT } from "@/constants/demo";

export const ensureEvents = ensureStreamOnce({ name: DEMO_STREAM, subjects: [`${DEMO_SUBJECT}.>`, DEMO_DLQ] });
