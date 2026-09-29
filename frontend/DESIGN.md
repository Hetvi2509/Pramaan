# Pramaan: UI system

Run: `npm install`, then `npm run dev` (port 5173). Build: `npm run build`.

## Rules

1. **shadcn only.** Every control comes from `src/components/ui`. No native `<select>`, date or time inputs. The calendar's month and year pickers are shadcn `Select`s (`calendar.tsx`, `CalendarDropdown`). Edit the component, don't work around it.
2. **Icons:** Phosphor only (`@phosphor-icons/react`), regular weight; `fill` marks state (done, warning, verified).
3. **Light only.** No dark mode, no `dark:` classes.
4. **Type:** Open Runde for display (`font-display`: titles, card titles, wordmark, big numerals), Inter for everything else, Cascadia/system mono for hashes, offsets, IDs. Open Runde has a single Regular weight, so never put `font-bold` on it; hierarchy is size and tracking. Scale is named by use: `text-display`, `text-title`, `text-heading`, `text-body`, `text-caption`, `text-eyebrow`.
5. **Theme:** tweakcn "poppy-1" tokens in `src/index.css`. Additions below the "Pramaan additions" comment are ours.

## Colour has one meaning each

| Colour | Means |
|---|---|
| Indigo (`primary`) | Interactive, selected, current step. Also "repaired" footage. |
| Teal (`secondary`) | Live footage |
| Amber (`accent`) | Deleted footage. Never used as hover or selected state. |
| Green (`success`) | Verified, consistent |
| Warning / danger | Needs attention / tamper or conflict |

White text on the theme's teal and on `destructive` fails contrast, so `Button` `secondary` is a soft indigo tint and `destructive` uses the darker `--danger`.

## Surfaces

- **Structure gets a border, elevation gets a shadow.** Cards and tables use the theme's black 1px outline. Popovers, menus, dialogs and sheets use `smooth-shadow-ring-lg` (shadow-plugin), with no extra border.
- Row dividers and chrome (sidebar edge, top bar) use `--hairline`, not the black border.
- Radius: `--radius` is 1rem. Nested radii are concentric (menu `rounded-lg` around `rounded-sm` items).
- Spacing: page padding `px-10`, sections `space-y-12/14`, card padding 24px, header block 12px inside, 40px to content.

## Motion

Press = `scale(0.96)` on transform only. Icon swaps use scale 0.25 to 1, opacity, blur 4px to 0 on `cubic-bezier(0.2, 0, 0, 1)` (`copy-button.tsx`). No `transition: all`. `prefers-reduced-motion` is honoured globally.

## Skills

`.claude/` is gitignored. Restore skills with `npx skills experimental_install` (reads `skills-lock.json` at the repo root). Sources: emilkowalski/skills, jakubkrehel/skills.
