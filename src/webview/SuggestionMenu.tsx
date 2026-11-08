/**
 * @module SuggestionMenu
 * Autocomplete list opened by a trigger character in the composer: `@` for mentions, `/` for slash commands (#11).
 * Presentational only: the composer owns the token, the items, the highlight, and the keys, and keeps focus in its
 * textarea, which points at the highlighted row with `aria-activedescendant` (`optionId`).
 */
import { useEffect } from "react";

/** One row. `icon`: kind marker class (`file`, `folder`), drawn in CSS. */
export type MenuItem = { key: string; label: string; icon?: string };

export type SuggestionMenuProps = {
  /** Listbox id; option ids derive from it. */
  id: string;
  /** Shown before each label, as typed in the composer. */
  trigger: string;
  /** Accessible name of the list. */
  label: string;
  items: MenuItem[];
  highlighted: number;
  onPick: (index: number) => void;
  /** Lines under the rows, such as "No match". */
  notices?: string[];
};

export function SuggestionMenu({ id, trigger, label, items, highlighted, onPick, notices = [] }: SuggestionMenuProps) {
  useEffect(() => {
    document.getElementById(optionId(id, highlighted))?.scrollIntoView({ block: "nearest" });
  }, [id, highlighted]);

  return (
    <div className="menu">
      <div id={id} role="listbox" aria-label={label} className="menu-list">
        {items.map((item, index) => (
          // biome-ignore lint/a11y/useKeyWithClickEvents: keys stay in the composer textarea, which drives the highlight.
          <div
            key={item.key}
            id={optionId(id, index)}
            role="option"
            // [>]: Focus stays in the textarea (`aria-activedescendant`); -1 keeps the row out of the tab order.
            tabIndex={-1}
            aria-selected={index === highlighted}
            className={index === highlighted ? "highlighted" : undefined}
            // [>]: Keep focus and caret in the textarea; the click then picks.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(index)}
          >
            {item.icon && <span className={`kind ${item.icon}`} aria-hidden="true" />}
            <span className="menu-label">
              {trigger}
              {item.label}
            </span>
          </div>
        ))}
      </div>
      {notices.map((notice) => (
        <p key={notice} className="menu-notice">
          {notice}
        </p>
      ))}
    </div>
  );
}

export function optionId(menuId: string, index: number): string {
  return `${menuId}-option-${index}`;
}

/** Highlight after moving `step` rows among `count`, wrapping at both ends. */
export function moveHighlight(current: number, step: number, count: number): number {
  return count === 0 ? 0 : (((current + step) % count) + count) % count;
}
