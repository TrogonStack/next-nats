const ENTITIES: Record<string, string> = { "&quot;": '"', "&amp;": "&", "&lt;": "<", "&gt;": ">", "&#x27;": "'", "&#39;": "'" };

export function decodeEntities(text: string): string {
  return text.replace(/&(?:quot|amp|lt|gt|#x27|#39);/g, (entity) => ENTITIES[entity] ?? entity);
}

export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

export function testId(html: string, id: string): string | undefined {
  return new RegExp(`data-testid="${id}">([^<]*)`).exec(html)?.[1];
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match ? decodeEntities(match[1]!) : undefined;
}

export interface FormButton {
  label: string;
  name?: string;
}

export interface ParsedForm {
  fields: Array<[string, string]>;
  buttons: FormButton[];
}

export function parseForms(html: string): ParsedForm[] {
  const forms: ParsedForm[] = [];
  for (const [, body] of html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)) {
    const fields: Array<[string, string]> = [];
    for (const [tag] of body!.matchAll(/<input\b[^>]*>/g)) {
      const name = attribute(tag, "name");
      if (name !== undefined) fields.push([name, attribute(tag, "value") ?? ""]);
    }
    for (const [, tag, options] of body!.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
      const name = attribute(tag!, "name");
      if (name === undefined) continue;
      const selected = /<option\b[^>]*value="([^"]*)"[^>]*selected/.exec(options!) ?? /<option\b[^>]*value="([^"]*)"/.exec(options!);
      fields.push([name, selected?.[1] ?? ""]);
    }
    const buttons = [...body!.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(([, tag, label]) => ({
      label: stripTags(label!),
      name: attribute(` ${tag!}`, "name"),
    }));
    forms.push({ fields, buttons });
  }
  return forms;
}

export interface SubmitOptions {
  origin: string;
  path: string;
  button: string;
  values?: Record<string, string>;
}

export async function submitForm({ origin, path, button, values = {} }: SubmitOptions): Promise<string> {
  const page = await (await fetch(`${origin}${path}`)).text();
  const match = parseForms(page)
    .map((form) => ({ form, submitter: form.buttons.find((candidate) => candidate.label === button) }))
    .find((candidate) => candidate.submitter);
  if (!match?.submitter) throw new Error(`No form with a "${button}" button on ${path}`);
  const { form, submitter } = match;
  const body = new FormData();
  if (submitter.name) body.append(submitter.name, "");
  const overridden = new Set(Object.keys(values));
  for (const [name, value] of form.fields) if (!overridden.has(name)) body.append(name, value);
  for (const [name, value] of Object.entries(values)) body.append(name, value);
  const response = await fetch(`${origin}${path}`, { method: "POST", body });
  if (!response.ok) throw new Error(`Form "${button}" on ${path} answered ${response.status}`);
  return response.text();
}
