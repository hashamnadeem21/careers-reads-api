// Owned by blognest-api (originally blognest/src/lib/categories.ts). The website keeps its own copy for its file fallback; keep the rules in step.
/**
 * Blog categories.
 *
 * The typed list below is the built-in default. When DATABASE_URL is set the
 * admin panel manages categories in the database, and `ensureSiteData()`
 * (src/lib/categories-loader.ts) replaces the contents of `categories` and
 * `categoryList` in place before pages read them, so every existing
 * synchronous lookup keeps working.
 */
export const CATEGORY_SLUGS = [
  "technology",
  "ai",
  "lifestyle",
  "productivity",
  "travel",
  "personal-development",
] as const;

/** Any category slug. Categories can be added in the admin panel, so this is not a closed union. */
export type CategorySlug = string;

export interface Category {
  slug: CategorySlug;
  name: string;
  /** Used in <title> and H1 of category pages. */
  headline: string;
  description: string;
  /** Tailwind gradient stops used for category accents. */
  accent: string;
}

const defaultCategories: Record<string, Category> = {
  technology: {
    slug: "technology",
    name: "Technology",
    headline: "Technology guides and explainers",
    description:
      "Plain-language explainers on the devices, software, and web technologies that shape everyday work and life.",
    accent: "from-sky-500 to-indigo-500",
  },
  ai: {
    slug: "ai",
    name: "AI",
    headline: "AI tools and practical AI guides",
    description:
      "Hands-on guides to AI tools, how they work, where they help, and where human judgment still matters most.",
    accent: "from-indigo-500 to-violet-500",
  },
  lifestyle: {
    slug: "lifestyle",
    name: "Lifestyle",
    headline: "Lifestyle ideas for calmer, healthier days",
    description:
      "Thoughtful ideas for home, health habits, and slowing down, written to be practical rather than aspirational.",
    accent: "from-rose-500 to-orange-400",
  },
  productivity: {
    slug: "productivity",
    name: "Productivity",
    headline: "Productivity systems that actually stick",
    description:
      "Systems, routines, and tools for doing focused work without burning out, tested against real schedules.",
    accent: "from-emerald-500 to-teal-500",
  },
  travel: {
    slug: "travel",
    name: "Travel",
    headline: "Travel planning tips and slow-travel guides",
    description:
      "Planning advice, packing strategies, and ways to travel more lightly, affordably, and respectfully.",
    accent: "from-amber-500 to-rose-500",
  },
  "personal-development": {
    slug: "personal-development",
    name: "Personal Development",
    headline: "Personal development and lifelong learning",
    description:
      "Evidence-informed approaches to learning, decision-making, habits, and growing a little every week.",
    accent: "from-violet-500 to-fuchsia-500",
  },
};

const DEFAULT_ACCENT = "from-sky-500 to-indigo-500";

/** Shown if content points at a category that hasn't loaded yet, instead of crashing the page. */
function fallbackCategory(slug: string): Category {
  const name = slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return { slug, name, headline: name, description: name, accent: DEFAULT_ACCENT };
}

const registry: Record<string, Category> = { ...defaultCategories };

/** Lookup by slug. Unknown slugs return a readable fallback rather than undefined. */
export const categories: Record<CategorySlug, Category> = new Proxy(registry, {
  get: (target, key) => (typeof key === "string" && !(key in target) ? fallbackCategory(key) : Reflect.get(target, key)),
});

/** Categories in display order. */
export const categoryList: Category[] = CATEGORY_SLUGS.map((slug) => defaultCategories[slug]);

export function isCategorySlug(value: string): value is CategorySlug {
  return Object.hasOwn(registry, value);
}

export function getCategory(slug: string): Category | undefined {
  return isCategorySlug(slug) ? registry[slug] : undefined;
}

/** Replaces the active categories (called by the database loader). An empty list keeps the defaults. */
export function replaceCategories(next: (Omit<Category, "accent"> & { accent?: string | null })[]): void {
  if (next.length === 0) return;
  const list = next.map((c) => ({ ...c, accent: c.accent || DEFAULT_ACCENT }));
  for (const key of Object.keys(registry)) delete registry[key];
  for (const c of list) registry[c.slug] = c;
  categoryList.splice(0, categoryList.length, ...list);
}
