"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, LoaderCircle } from "lucide-react";
import {
  emptySurveyAnswers, parseSurveyAnswers, stepFields, surveyOptions, visibleSurveySteps, SURVEY_REQUIREMENTS_LIMIT,
  type SurveyAnswers, type SurveyChoice, type SurveyErrors, type SurveyField, type SurveyStep,
} from "@pnlx/survey";
import { apiPath } from "@/lib/api-path";
import { CountrySelect } from "./country-select";
import styles from "./trader-survey.module.css";

export function TraderSurvey({ previewConfirmation = false }: { previewConfirmation?: boolean } = {}) {
  const [answers, setAnswers] = useState<SurveyAnswers>(emptySurveyAnswers);
  const [step, setStep] = useState<SurveyStep>("about");
  const [errors, setErrors] = useState<SurveyErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(previewConfirmation);
  const heading = useRef<HTMLHeadingElement>(null);
  const submissionId = useRef("");
  const busy = useRef(false);
  const website = useRef<HTMLInputElement>(null);
  const steps = visibleSurveySteps(answers.activity);
  const stepIndex = steps.indexOf(step);
  const lastStep = stepIndex === steps.length - 1;

  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [step, submitted]);

  function update<K extends SurveyField>(field: K, value: SurveyAnswers[K]) {
    setAnswers((previous) => ({ ...previous, [field]: value }));
    setErrors((previous) => ({ ...previous, [field]: undefined, form: undefined }));
  }

  function move(next: SurveyStep) {
    setErrors({});
    setStep(next);
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function showErrors(nextErrors: SurveyErrors, fields: SurveyField[]) {
    setErrors(nextErrors);
    const first = fields.find((field) => nextErrors[field]);
    requestAnimationFrame(() => {
      const element = document.getElementById(`survey-${first}`);
      element?.scrollIntoView({ behavior: "smooth", block: "center" });
      element?.querySelector<HTMLElement>("input, textarea, select")?.focus({ preventScroll: true });
    });
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    const parsed = parseSurveyAnswers(answers);
    const relevantErrors = Object.fromEntries(stepFields[step].filter((field) => parsed.errors[field]).map((field) => [field, parsed.errors[field]]));
    if (Object.keys(relevantErrors).length) { showErrors(relevantErrors, stepFields[step]); return; }
    if (!lastStep) { move(steps[stepIndex + 1]); return; }
    if (Object.keys(parsed.errors).length) {
      const invalidStep = steps.find((candidate) => stepFields[candidate].some((field) => parsed.errors[field]));
      if (invalidStep) setStep(invalidStep);
      showErrors(parsed.errors, Object.keys(parsed.errors) as SurveyField[]);
      return;
    }
    busy.current = true;
    setSubmitting(true);
    setErrors({});
    if (!submissionId.current) submissionId.current = crypto.randomUUID();
    const source = new URLSearchParams(window.location.search).get("utm_source")?.replace(/[^a-zA-Z0-9_. -]/g, "").slice(0, 80);
    try {
      const response = await fetch(apiPath("/survey/responses"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ submissionId: submissionId.current, answers: parsed.answers, source, website: website.current?.value ?? "" }),
        signal: AbortSignal.timeout(15_000),
      });
      const result = await response.json();
      if (!response.ok || result.saved !== true) {
        if (result.fields && typeof result.fields === "object") {
          const invalidStep = steps.find((candidate) => stepFields[candidate].some((field) => typeof result.fields[field] === "string"));
          if (invalidStep) setStep(invalidStep);
          setErrors({ ...result.fields, form: "Please check the highlighted answers." });
        } else {
          setErrors({ form: typeof result.error === "string" ? result.error : "We couldn’t save your response. Please try again." });
        }
        return;
      }
      setSubmitted(true);
      // Responses stay in memory while completing the form; clear them after confirmed storage.
      setAnswers(emptySurveyAnswers());
      window.scrollTo({ top: 0, behavior: "instant" });
    } catch {
      setErrors({ form: "We couldn’t reach the survey service. Your answers are still here; please try again." });
    } finally { busy.current = false; setSubmitting(false); }
  }

  const choices = (field: SurveyField, label: string, options: readonly SurveyChoice[], settings: { multiple?: boolean; max?: number; optional?: boolean; hint?: string } = {}) => (
    <ChoiceQuestion key={field} field={field} label={label} options={options} value={answers[field]} onChange={(value) => update(field, value)} error={errors[field]}
      otherValue={answers[`${field}Other` as SurveyField] as string | undefined} otherError={errors[`${field}Other` as SurveyField]}
      onOtherChange={(value) => update(`${field}Other` as SurveyField, value)} {...settings} />
  );

  const text = (field: SurveyField, label: string) => (
    <Question field={field} label={label} optional error={errors[field]}>
      <textarea id={`survey-input-${field}`} name={field} rows={3} maxLength={1200} value={answers[field] as string}
        aria-labelledby={`survey-label-${field}`} aria-invalid={Boolean(errors[field])} aria-describedby={errors[field] ? `survey-error-${field}` : undefined}
        onChange={(event) => update(field, event.target.value)} />
    </Question>
  );

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Link href="/" aria-label="PNLX home" className={styles.brand}>
          <Image src="/pnlx-logo.png" alt="PNLX" width={166} height={31} priority />
        </Link>
        <Link href="/" className={styles.homeLink}>Home</Link>
      </header>

      {submitted ? (
        <main className={styles.success}>
          <h1 tabIndex={-1} ref={heading}>Thank you for your contribution.</h1>
          <p>Follow PNLX on X or join our Telegram community for updates.</p>
          <div className={styles.communityLinks}>
            <a href="https://x.com/PNLX_DEX" target="_blank" rel="noopener noreferrer">Follow on X <ArrowUpRight size={16} /></a>
            <a href="https://t.me/+GWQG4SlxOjZjNDI0" target="_blank" rel="noopener noreferrer">Join Telegram <ArrowUpRight size={16} /></a>
          </div>
          <Link href="/" className={styles.primaryButton}>Back to PNLX</Link>
        </main>
      ) : (
        <main className={styles.layout}>
          <div className={styles.pageHeading}>
            <h1 id="survey-heading" ref={heading} tabIndex={-1} aria-describedby="survey-step">Trader survey</h1>
            <span id="survey-step" aria-live="polite">{stepIndex + 1} / {steps.length}</span>
          </div>
          <section className={styles.formPanel} aria-labelledby="survey-heading">
            <form onSubmit={onSubmit} noValidate>
              <div className={styles.honeypot} aria-hidden="true">
                <label htmlFor="survey-website">Website</label>
                <input id="survey-website" name="website" ref={website} tabIndex={-1} autoComplete="off" />
              </div>

              <div className={styles.questions} key={step}>
                {step === "about" && <>
                  {choices("activity", "When did you last trade?", surveyOptions.activity)}
                  {answers.activity && answers.activity !== "never" && <>
                    {choices("products", "Which products do you trade?", surveyOptions.products, { multiple: true })}
                    {choices("platforms", "Which trading platforms do you use?", surveyOptions.platforms, { multiple: true })}
                  </>}
                </>}

                {step === "experience" && <>
                  {text("problem", "What problem, if any, have you experienced recently on your main platform?")}
                  {choices("priorities", "What matters most when choosing a trading platform?", surveyOptions.priorities, { multiple: true, max: 3 })}
                  {choices("funding", "How do you usually fund your trading account?", surveyOptions.funding, { multiple: true })}
                </>}

                {step === "research" && <>
                  {choices("sources", "Where have you found trading ideas in the past 30 days?", surveyOptions.sources, { multiple: true })}
                  {text("researchProblem", "What is missing or frustrating about the research or signal tools you use?")}
                  {choices("privacy", "How important is trading privacy when choosing a platform?", surveyOptions.privacy)}
                  {text("privacyExperience", "Have you had problems because someone could see your trades, positions or wallet activity?")}
                </>}

                {step === "pnlx" && <>
                  <div className={styles.productNote}>
                    <p>We’re building PNLX, a private perpetual trading app on Stellar with fiat funding options.</p>
                    <p>We’re also developing a <strong>Market Analysis Agent</strong> to help you assess trade setups and find potential trading opportunities. You review the recommendations and decide which trades to execute.</p>
                  </div>
                  {text("interest", "What, if anything, interests you about PNLX?")}
                  {choices("requirements", "What would you need to see before trying PNLX?", surveyOptions.requirements, { multiple: true, max: SURVEY_REQUIREMENTS_LIMIT })}
                  {choices("stellar", "Before this survey, how familiar were you with the Stellar network?", surveyOptions.stellar)}
                </>}

                {step === "followUp" && <>
                  <Question field="country" label="Which country do you live in?" optional error={errors.country}>
                    <CountrySelect value={answers.country} onChange={(value) => update("country", value)} error={errors.country} />
                  </Question>
                  {choices("followUp", "Would you like to take part?", surveyOptions.followUp, { multiple: true, optional: true })}
                  {answers.followUp.length > 0 && <>
                    <Question field="contactMethod" label="How should we contact you?" error={errors.contactMethod}>
                      <div className={styles.contactMethods}>
                        {[ ["email", "Email"], ["telegram", "Telegram"] ].map(([value, label]) => (
                          <label key={value} className={styles.contactMethod}>
                            <input type="radio" name="contactMethod" value={value} checked={answers.contactMethod === value} onChange={() => update("contactMethod", value)} /> {label}
                          </label>
                        ))}
                      </div>
                    </Question>
                    <Question field="contact" label={answers.contactMethod === "email" ? "Email address" : "Telegram username"} error={errors.contact}>
                      <input id="survey-input-contact" name="contact" type={answers.contactMethod === "email" ? "email" : "text"} autoComplete={answers.contactMethod === "email" ? "email" : "off"} maxLength={254}
                        aria-labelledby="survey-label-contact"
                        placeholder={answers.contactMethod === "email" ? "you@example.com" : "@yourname"} value={answers.contact} onChange={(event) => update("contact", event.target.value)}
                        aria-invalid={Boolean(errors.contact)} aria-describedby={errors.contact ? "survey-error-contact" : undefined} />
                    </Question>
                  </>}
                  <p className={styles.dataNote}>Responses support PNLX research. Contact details are used only for the follow-up you select.</p>
                </>}
              </div>

              {errors.form && <p className={styles.formError} role="alert">{errors.form}</p>}
              <div className={styles.formActions}>
                {stepIndex > 0 ? <button type="button" className={styles.backButton} onClick={() => move(steps[stepIndex - 1])} disabled={submitting}><ArrowLeft size={16} /> Back</button>
                  : <span />}
                <button type="submit" className={styles.primaryButton} disabled={submitting}>
                  {submitting ? <>Submitting <LoaderCircle className={styles.spinner} size={17} /></> : <>{lastStep ? "Submit" : "Continue"}<ArrowRight size={17} /></>}
                </button>
              </div>
            </form>
          </section>
        </main>
      )}

    </div>
  );
}

function Question({ field, label, hint, optional, error, children }: {
  field: SurveyField; label: string; hint?: string; optional?: boolean; error?: string; children: ReactNode;
}) {
  return (
    <fieldset id={`survey-${field}`} className={styles.question} aria-invalid={Boolean(error)} aria-describedby={error ? `survey-error-${field}` : hint ? `survey-hint-${field}` : undefined}>
      <legend id={`survey-label-${field}`}>{label}{optional && <span className={styles.optional}>Optional</span>}</legend>
      {hint && <p id={`survey-hint-${field}`} className={styles.hint}>{hint}</p>}
      {children}
      {error && <p id={`survey-error-${field}`} className={styles.fieldError} role="alert">{error}</p>}
    </fieldset>
  );
}

function ChoiceQuestion({ field, label, options, value, onChange, multiple = false, max, optional, hint, error, otherValue, otherError, onOtherChange }: {
  field: SurveyField; label: string; options: readonly SurveyChoice[]; value: string | string[];
  onChange: (value: string | string[]) => void; multiple?: boolean; max?: number; optional?: boolean; hint?: string; error?: string;
  otherValue?: string; otherError?: string; onOtherChange: (value: string) => void;
}) {
  const selected = Array.isArray(value) ? value : value ? [value] : [];
  function toggle(id: string) {
    if (!multiple) { onChange(id); return; }
    if (selected.includes(id)) onChange(selected.filter((item) => item !== id));
    else if (id === "none") onChange(["none"]);
    else onChange([...selected.filter((item) => item !== "none"), id]);
  }
  const defaultHint = multiple ? max ? `Select up to ${max}.` : "Select all that apply." : undefined;
  return (
    <Question field={field} label={label} hint={hint ?? defaultHint} optional={optional} error={error}>
      <div className={`${styles.choices} ${!multiple || field === "followUp" ? styles.singleColumn : ""}`}>
        {options.map(([id, title]) => {
          const checked = selected.includes(id);
          const disabled = Boolean(multiple && max && selected.length >= max && !checked && id !== "none");
          return <label key={id} className={`${styles.choice} ${checked ? styles.selected : ""}`}>
            <input type={multiple ? "checkbox" : "radio"} name={field} value={id} checked={checked} onChange={() => toggle(id)} disabled={disabled}
              aria-invalid={Boolean(error)} aria-describedby={error ? `survey-error-${field}` : hint || defaultHint ? `survey-hint-${field}` : undefined} />
            <span className={`${styles.indicator} ${!multiple ? styles.radioIndicator : ""}`} aria-hidden="true">{checked && (multiple ? <Check size={12} strokeWidth={2.5} /> : <span />)}</span>
            <span>{title}</span>
          </label>;
        })}
      </div>
      {selected.includes("other") && <div id={`survey-${field}Other`} className={styles.other}>
        <label htmlFor={`survey-input-${field}Other`}>Please specify</label>
        <input id={`survey-input-${field}Other`} name={`${field}Other`} type="text" maxLength={160} value={otherValue ?? ""} onChange={(event) => onOtherChange(event.target.value)} placeholder="Your answer"
          aria-invalid={Boolean(otherError)} aria-describedby={otherError ? `survey-error-${field}Other` : undefined} />
        {otherError && <p id={`survey-error-${field}Other`} className={styles.fieldError} role="alert">{otherError}</p>}
      </div>}
    </Question>
  );
}
