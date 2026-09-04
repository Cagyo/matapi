import { describe, expect, it } from "vitest";

import { ListPrivateSubnetSuggestionsUseCase } from "../../../src/camera/application/list-private-subnet-suggestions.use-case";
import { InMemoryPrivateSubnetDetectorAdapter } from "../../../src/camera/infrastructure/in-memory-private-subnet-detector.adapter";

describe("ListPrivateSubnetSuggestionsUseCase", () => {
  it("projects the bounded detector result into eight-item pages with page-local opaque selectors", async () => {
    const detector = new InMemoryPrivateSubnetDetectorAdapter(
      Array.from({ length: 32 }, (_, index) => ({
        cidr: `10.0.${index}.0/24`,
        interfaceLabels: [`veth${index}`],
      })),
    );

    const page = await new ListPrivateSubnetSuggestionsUseCase(detector).execute(2);

    expect(page).toMatchObject({ page: 2, pageCount: 4, truncated: true });
    expect(page.items).toHaveLength(8);
    expect(page.items[0]).toMatchObject({ cidr: "10.0.8.0/24", selector: "0" });
    expect(page.items[0].selector).toMatch(/^[A-Za-z0-9_-]{1,8}$/);
    expect(page.items.every(({ cidr }) => !cidr.includes("8.8.8."))).toBe(true);
  });
});
