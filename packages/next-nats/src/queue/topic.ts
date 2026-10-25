import { subject } from "../values.js";

const TOPIC = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;
const GROUP = /^[A-Za-z0-9_-]+$/;

export function assertTopic(topic: string): string {
  if (!TOPIC.test(topic)) throw new TypeError(`Invalid queue topic "${topic}": use dot separated tokens of letters, digits, "-" and "_"`);
  return topic;
}

export function assertGroup(group: string): string {
  if (!GROUP.test(group)) throw new TypeError(`Invalid consumer group "${group}": use letters, digits, "-" and "_"`);
  return group;
}

export function durableFor(topic: string, group: string): string {
  return `${topic.replace(/\./g, "_")}__${group}`;
}

export function subjects(prefix: string, topic: string) {
  return {
    message: subject(`${prefix}.t.${topic}`),
    schedule: (id: string) => subject(`${prefix}.s.${topic}.${id}`),
    deadLetter: subject(`${prefix}.d.${topic}`),
  };
}
