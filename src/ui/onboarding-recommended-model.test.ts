/**
 * The onboarding model picker leads with a catalog entry's `recommendedModel`
 * when the live list serves it, so a newcomer on a big gateway catalog
 * (AI/ML API lists 300+ chat ids) starts on a cheap tools+vision model.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { findProvider } from "../providers/catalog.js";
import { indexOfRecommendedModel, leadWithFreshMachineDefault } from "./onboarding.js";

const rows = [
	{ value: "alibaba/qwen-max", label: "alibaba/qwen-max" },
	{ value: "openai/gpt-5-mini", label: "openai/gpt-5-mini" },
	{ value: "anthropic/claude-sonnet-4.5", label: "anthropic/claude-sonnet-4.5" },
];

describe("onboarding — recommended starter model", () => {
	it("finds the AI/ML API starter model in the picker rows", () => {
		assert.equal(indexOfRecommendedModel(rows, findProvider("aimlapi")?.recommendedModel), 1);
	});

	it("is a no-op for providers without one, or when the live list lacks it", () => {
		assert.equal(indexOfRecommendedModel(rows, findProvider("openrouter")?.recommendedModel), -1);
		assert.equal(indexOfRecommendedModel(rows.slice(0, 1), "openai/gpt-5-mini"), -1);
	});
});

describe("onboarding — provider picker default on a fresh machine", () => {
	const row = (value: string, rank: number) => ({ rank, item: { value, label: value, description: value } });

	it("leads with AI/ML API when nothing is detected to reuse", () => {
		const items = leadWithFreshMachineDefault([row("anthropic", 2), row("openai", 4), row("aimlapi", 3)]);
		assert.equal(items[0]!.value, "aimlapi");
		assert.match(items[0]!.description!, /recommended/);
		assert.deepEqual(items.map((i) => i.value), ["aimlapi", "anthropic", "openai"]);
	});

	it("leaves the login-first order alone once a CLI login or env key is detected", () => {
		const ranked = [row("openai", 1), row("anthropic", 2), row("aimlapi", 3)];
		assert.deepEqual(leadWithFreshMachineDefault(ranked).map((i) => i.value), ["openai", "anthropic", "aimlapi"]);
	});
});
