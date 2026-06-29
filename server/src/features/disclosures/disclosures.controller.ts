import { json, readJson } from "@/shared/http/json";
import { parseDisclosure, parseProvenDisclosure } from "@/features/disclosures/disclosures.schema";
import type { DisclosuresService } from "@/features/disclosures/disclosures.service";

export class DisclosuresController {
  constructor(private readonly disclosures: DisclosuresService) {}

  async create(request: Request): Promise<Response> {
    const body = await readJson<Record<string, string>>(request);
    return json({ disclosure: this.disclosures.create(parseDisclosure(body)) }, 201);
  }

  async createProven(request: Request): Promise<Response> {
    const body = await readJson<Record<string, string>>(request);
    return json({ disclosure: this.disclosures.createProven(parseProvenDisclosure(body)) }, 201);
  }
}
