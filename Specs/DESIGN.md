# Design System Specification: The Hearthside Digital (Share, Instead.)

## 1. Overview & Creative North Star
**Creative North Star: "The Modern Commons"**
This design system moves beyond the transactional nature of "sharing apps" and positions the interface as a premium editorial experience for local communities. We are building "The Modern Commons"—a space that feels as warm as a neighborhood library but as sophisticated as a high-end lifestyle magazine. 

We break the "standard app template" look by utilizing intentional asymmetry, oversized typography, and deep tonal layering. The goal is to move away from rigid, boxed-in grids and toward a fluid, breathing layout that feels organic and trustworthy.

---

## 2. Colors & Surface Architecture
The color palette is rooted in a "Cream White" foundation to provide a softer, more human touch than clinical pure white.

### The "No-Line" Rule
**Strict Mandate:** Designers are prohibited from using 1px solid borders to define sections or containers. 
Structure must be achieved through:
*   **Background Shifts:** Using `surface-container-low` sections against a `surface` background.
*   **Tonal Nesting:** A `surface-container-lowest` card sitting on a `surface-container` background.
*   **Negative Space:** Using generous margins (24px+) to imply boundaries.

### Surface Hierarchy & Nesting
Treat the UI as physical layers of high-quality paper and glass.
*   **Level 0 (Base):** `surface` (#fbf9f6) - Used for global backgrounds.
*   **Level 1 (Sections):** `surface-container` (#efeeeb) - Used for large content blocks or sidebars.
*   **Level 2 (Cards/Interaction):** `surface-container-lowest` (#ffffff) - Used for primary interactive cards to provide a "lifted" appearance against the cream base.

### Signature Textures & Glassmorphism
To avoid a "flat" or "cheap" feel:
*   **The Forest Gradient:** Primary CTAs should use a subtle linear gradient: `primary` (#0d631b) to `primary_container` (#2e7d32) at 135 degrees.
*   **Community Glass:** Overlays, navigation bars, and floating action buttons (FABs) must use a Glassmorphic effect: `surface` color at 80% opacity with a `20px` backdrop-blur.

---

## 3. Typography: Editorial Authority
We use **Lexend** exclusively. Its rounded terminals provide the "friendly" community vibe, but our scale provides the "professional" authority.

*   **Display Scale:** Use `display-lg` (3.5rem) with tight letter-spacing (-0.02em) for hero moments. This creates a bold, editorial "magazine" feel.
*   **Headline Scale:** `headline-md` (1.75rem) should be used for section headers to anchor the eye.
*   **The \"Readable Body\":** `body-lg` (1rem) is the standard for community posts. Use a generous line-height (1.6) to ensure long-form reading feels effortless.
*   **Label Utility:** `label-md` (0.75rem) should be set in All Caps with +0.05em letter spacing when used for categories or tags to provide a structured, premium look.

---

## 4. Elevation & Depth
Depth is conveyed through **Tonal Layering** rather than structural lines or harsh shadows.

*   **The Layering Principle:** To highlight a "Community Tool" card, do not add a border. Place a `surface-container-lowest` card on a `surface-container-low` background. The subtle shift from #f5f3f0 to #ffffff creates a sophisticated, natural lift.
*   **Ambient Shadows:** If an element must "float" (e.g., a Modal or FAB), use a shadow tinted with the `on_surface` color: `box-shadow: 0 12px 40px rgba(51, 51, 51, 0.06)`. It should feel like a soft glow of light, not a dark drop shadow.
*   **The "Ghost Border" Fallback:** If accessibility requires a stroke (e.g., in high-contrast modes), use the `outline_variant` token at **15% opacity**. Never use a 100% opaque border.

---

## 5. Components

### Buttons (The Interaction Core)
*   **Primary:** Gradient of `primary` to `primary_container`. 8px (`DEFAULT`) radius. No border. Text is `on_primary`.
*   **Secondary:** `secondary_container` background with `on_secondary_container` text. Use for "Add to Wishlist" or "Message Neighbor."
*   **Tertiary:** Transparent background with `primary` text. No container. High-end editorial style.

### Input Fields (Trust & Clarity)
*   **Styling:** Inputs should use `surface_container_low` as a background. Instead of a 4-sided border, use a 2px bottom-accent of `primary` only when focused.
*   **Typography:** Labels use `label-md`. Helper text uses `body-sm`.

### Cards & Lists (Asymmetric Sharing)
*   **Prohibition:** No divider lines. Use `1.5rem (xl)` spacing between list items or a subtle background shift between rows.
*   **The "Neighbor Card":** A `surface-container-lowest` container with `lg` (1rem) corner radius. Imagery should be slightly inset to create a "framed" look.

### Community Chips
*   **Filter Chips:** Use `secondary_fixed` (#ffdcbe) with `on_secondary_fixed` (#2c1600) text for a vibrant "Sunset Orange" pop that draws attention to categories like "Borrowing" or "Free."

---

## 6. Do's and Don'ts

### Do
*   **Do** use asymmetrical layouts. For example, a 2-column grid where the left column is 60% width and the right is 40%.
*   **Do** use the "Cream White" (`surface`) for the vast majority of the UI to maintain warmth.
*   **Do** apply `8px` (`DEFAULT`) roundness to buttons, but feel free to use `full` roundness for avatars and selection chips.

### Don't
*   **Don't** use pure black (#000000). Always use `charcoal` (#333333) or `on_surface` (#1b1c1a) for text.
*   **Don't** use standard 1px borders. If you feel you need one, use a background color shift instead.
*   **Don't** crowd the interface. If a screen feels full, add 16px of padding. Space is the ultimate luxury in UI.
*   **Don't** use "Forest Green" for everything. Reserve it for primary actions and brand moments to keep its impact high.
