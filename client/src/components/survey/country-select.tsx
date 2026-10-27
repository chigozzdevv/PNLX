"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown } from "lucide-react";
import { surveyCountries } from "@pnlx/survey";
import styles from "./trader-survey.module.css";

const options: readonly { code: string; name: string; flag: string }[] = [
  { code: "", name: "Prefer not to say", flag: "" }, ...surveyCountries,
];
const searchable = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export function CountrySelect({ value, onChange, error }: {
  value: string; onChange: (code: string) => void; error?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const selected = surveyCountries.find(({ code }) => code === value);
  const search = searchable(query.trim());
  const filtered = options.filter(({ code, name }) => searchable(name).includes(search) || code.toLowerCase() === search);
  const activeId = open && filtered[active] ? `survey-country-${filtered[active].code || "none"}` : undefined;

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  function showOptions() {
    setQuery("");
    setActive(Math.max(0, options.findIndex(({ code }) => code === value)));
    setOpen(true);
  }

  function choose(code: string) {
    onChange(code);
    setOpen(false);
    setQuery("");
    input.current?.focus({ preventScroll: true });
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) { showOptions(); return; }
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActive((previous) => filtered.length ? (previous + direction + filtered.length) % filtered.length : 0);
    } else if (event.key === "Enter" && open) {
      event.preventDefault();
      if (filtered[active]) choose(filtered[active].code);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === "Tab") setOpen(false);
  }

  return (
    <div className={styles.countrySelect} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      <div className={styles.countryInputWrap}>
        <input id="survey-input-country" ref={input} name="country" type="text" role="combobox"
          autoComplete="off" aria-autocomplete="list" aria-expanded={open} aria-controls={open ? "survey-country-list" : undefined}
          aria-activedescendant={activeId} aria-labelledby="survey-label-country" aria-invalid={Boolean(error)}
          aria-describedby={error ? "survey-error-country" : undefined}
          value={open ? query : selected ? `${selected.flag} ${selected.name}` : ""}
          placeholder={open ? "Search countries" : "Select country"}
          onFocus={showOptions} onClick={() => { if (!open) showOptions(); }} onKeyDown={onKeyDown}
          onChange={(event) => { setQuery(event.target.value); setActive(0); setOpen(true); }} />
        <button type="button" className={styles.countryToggle} aria-label={open ? "Close country list" : "Open country list"}
          onMouseDown={(event) => event.preventDefault()} onClick={() => {
            if (open) setOpen(false);
            else { input.current?.focus({ preventScroll: true }); showOptions(); }
          }}><ChevronDown size={16} /></button>
      </div>
      {open && <ul id="survey-country-list" className={styles.countryList} role="listbox" aria-label="Countries">
        {filtered.map(({ code, name, flag }, index) => (
          <li key={code || "none"} id={`survey-country-${code || "none"}`} role="option" aria-selected={code === value}
            className={`${styles.countryOption} ${active === index ? styles.activeCountry : ""}`}
            onMouseDown={(event) => event.preventDefault()} onMouseMove={() => setActive(index)} onClick={() => choose(code)}
            onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(code); } }}>
            {flag && <span aria-hidden="true">{flag}</span>}<span>{name}</span>
          </li>
        ))}
        {filtered.length === 0 && <li role="presentation" className={styles.countryEmpty}>No countries found.</li>}
      </ul>}
    </div>
  );
}
