import { serviceClient } from "next-nats/services";
import type { calculator, probe } from "./services";

export const calc = () => serviceClient<typeof calculator>("calculator", { timeout: 2_000 });
export const prober = () => serviceClient<typeof probe>("probe");
