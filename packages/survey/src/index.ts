import { surveyCountries } from "./countries";
export { surveyCountries } from "./countries";

export const SURVEY_ID = "trader-research-v1";
export const SURVEY_MAX_BYTES = 16_384;
export const SURVEY_REQUIREMENTS_LIMIT = 5;

export const surveyOptions = {
  activity: [
    ["recent", "Within the past 30 days"],
    ["past", "More than 30 days ago"],
    ["never", "I have never traded"],
  ],
  products: [
    ["spot", "Spot crypto"], ["perps", "Perpetual futures"],
    ["futures", "Other futures"], ["options", "Options"], ["other", "Other"],
  ],
  platforms: [
    ["bybit", "Bybit"], ["okx", "OKX"], ["binance", "Binance"],
    ["mexc", "MEXC"], ["hyperliquid", "Hyperliquid"], ["other", "Other"],
  ],
  priorities: [
    ["security", "Security and control of funds"], ["liquidity", "Liquidity and low slippage"],
    ["cost", "Fees and funding costs"], ["speed", "Execution speed"],
    ["reliability", "Reliability"], ["markets", "Available markets"],
    ["funding", "Easy deposits and withdrawals"], ["privacy", "Trading privacy"],
    ["usability", "Ease of use"], ["other", "Other"],
  ],
  funding: [
    ["crypto", "Crypto transfer"], ["bank", "Bank transfer"],
    ["card", "Debit or credit card"], ["p2p", "P2P purchase"], ["other", "Other"],
  ],
  sources: [
    ["own", "My own market analysis"], ["news", "News and official announcements"],
    ["x", "X"], ["communities", "Telegram or Discord"],
    ["people", "Friends or traders I follow"], ["paid", "Paid signal services"],
    ["ai", "AI tools or trading assistants"], ["other", "Other"],
    ["none", "I haven’t used outside sources"],
  ],
  privacy: [
    ["very", "Very important"], ["somewhat", "Somewhat important"],
    ["neutral", "Neither important nor unimportant"], ["little", "Not very important"],
    ["not", "Not important at all"], ["unsure", "I’m not sure"],
  ],
  requirements: [
    ["liquidity", "Liquidity and competitive quotes"], ["fees", "Clear fees and trading costs"],
    ["review", "Independent security review"], ["privacy", "Clear privacy guarantees"],
    ["withdrawals", "Reliable deposits and withdrawals"], ["onboarding", "Easy onboarding"],
    ["demo", "A working demo or testnet"], ["trust", "Recommendations from people I trust"],
    ["other", "Other"], ["none", "I’m not looking for another platform"],
  ],
  stellar: [
    ["used", "I have used Stellar"], ["heard", "I’ve heard of it, but haven’t used it"],
    ["new", "I hadn’t heard of it"], ["unsure", "I’m not sure"],
  ],
  followUp: [
    ["testnet", "Invite me to test PNLX"],
    ["interview", "Contact me for a short research interview"],
    ["updates", "Send me occasional PNLX updates"],
  ],
} as const;

export type SurveyChoice = readonly [string, string];
export type SurveyAnswers = {
  activity: string;
  products: string[];
  productsOther: string;
  platforms: string[];
  platformsOther: string;
  problem: string;
  priorities: string[];
  prioritiesOther: string;
  funding: string[];
  fundingOther: string;
  sources: string[];
  sourcesOther: string;
  researchProblem: string;
  privacy: string;
  privacyExperience: string;
  interest: string;
  requirements: string[];
  requirementsOther: string;
  stellar: string;
  country: string;
  followUp: string[];
  contactMethod: string;
  contact: string;
};

export type SurveyField = keyof SurveyAnswers;
export type SurveyErrors = Partial<Record<SurveyField | "form", string>>;
export type SurveySubmission = {
  submissionId: string;
  answers: SurveyAnswers;
  source?: string;
};

export const surveySteps = ["about", "experience", "research", "pnlx", "followUp"] as const;
export type SurveyStep = typeof surveySteps[number];
export const stepFields: Record<SurveyStep, SurveyField[]> = {
  about: ["activity", "products", "productsOther", "platforms", "platformsOther"],
  experience: ["problem", "priorities", "prioritiesOther", "funding", "fundingOther"],
  research: ["sources", "sourcesOther", "researchProblem", "privacy", "privacyExperience"],
  pnlx: ["interest", "requirements", "requirementsOther", "stellar"],
  followUp: ["country", "followUp", "contactMethod", "contact"],
};

export function emptySurveyAnswers(): SurveyAnswers {
  return {
    activity: "", products: [], productsOther: "", platforms: [], platformsOther: "",
    problem: "", priorities: [], prioritiesOther: "", funding: [], fundingOther: "",
    sources: [], sourcesOther: "", researchProblem: "", privacy: "", privacyExperience: "",
    interest: "", requirements: [], requirementsOther: "", stellar: "", country: "",
    followUp: [], contactMethod: "email", contact: "",
  };
}

export function visibleSurveySteps(activity: string): SurveyStep[] {
  return surveySteps.filter((step) => activity !== "never" || step !== "experience");
}

/** Validate on the server as well as in the form; copy only known, bounded fields. */
export function parseSurveyAnswers(input: unknown): { answers: SurveyAnswers; errors: SurveyErrors } {
  const answers = emptySurveyAnswers();
  const errors: SurveyErrors = {};
  const raw = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown> : {};

  function single(field: "activity" | "privacy" | "stellar") {
    const value = raw[field];
    if (typeof value !== "string" || !surveyOptions[field].some(([id]) => id === value)) {
      errors[field] = "Choose one option to continue.";
    } else answers[field] = value;
  }
  function multiple(field: "products" | "platforms" | "priorities" | "funding" | "sources" | "requirements" | "followUp", max = surveyOptions[field].length, required = true) {
    const values = raw[field];
    if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !surveyOptions[field].some(([id]) => id === value)) || new Set(values).size !== values.length) {
      errors[field] = "Choose from the listed options.";
      return;
    }
    if (values.length > max) errors[field] = `Choose up to ${max} options.`;
    else if (required && values.length === 0) errors[field] = "Choose at least one option to continue.";
    else if (values.includes("none") && values.length > 1) errors[field] = "Choose this option on its own.";
    answers[field] = values;
  }
  function text(field: SurveyField, limit: number, required = false) {
    const value = raw[field] ?? "";
    if (typeof value !== "string" || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
      errors[field] = `Use ${limit} characters or fewer.`;
      return;
    }
    const trimmed = value.trim();
    if (required && !trimmed) errors[field] = "Please add a short answer.";
    (answers[field] as string) = trimmed;
  }
  function other(field: "products" | "platforms" | "priorities" | "funding" | "sources" | "requirements") {
    if (answers[field].includes("other")) text(`${field}Other`, 160, true);
  }

  single("activity");
  if (answers.activity && answers.activity !== "never") {
    multiple("products"); other("products");
    multiple("platforms"); other("platforms");
    text("problem", 1200);
    multiple("priorities", 3); other("priorities");
    multiple("funding"); other("funding");
  }
  multiple("sources"); other("sources");
  text("researchProblem", 1200);
  single("privacy");
  text("privacyExperience", 1200);
  text("interest", 1200);
  multiple("requirements", SURVEY_REQUIREMENTS_LIMIT); other("requirements");
  single("stellar");
  text("country", 80);
  if (answers.country && !surveyCountries.some(({ code }) => code === answers.country)) {
    errors.country = "Select a country from the list.";
  }
  multiple("followUp", 3, false);
  if (answers.followUp.length > 0) {
    text("contactMethod", 10, true);
    text("contact", 254, true);
    if (!["email", "telegram"].includes(answers.contactMethod)) errors.contactMethod = "Choose email or Telegram.";
    if (answers.contactMethod === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(answers.contact)) {
      errors.contact = "Enter a valid email address.";
    }
    if (answers.contactMethod === "telegram" && !/^@?[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(answers.contact)) {
      errors.contact = "Enter your Telegram username, such as @yourname.";
    }
  } else {
    // Contact data is never retained without a selected purpose.
    answers.contactMethod = "";
    answers.contact = "";
  }
  return { answers, errors };
}

export function parseSurveySubmission(input: unknown): { submission?: SurveySubmission; errors: SurveyErrors } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { errors: { form: "Invalid survey response." } };
  const raw = input as Record<string, unknown>;
  const { answers, errors } = parseSurveyAnswers(raw.answers);
  if (typeof raw.submissionId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw.submissionId)) {
    errors.form = "Invalid submission. Refresh the page and try again.";
  }
  if (raw.source !== undefined && (typeof raw.source !== "string" || raw.source.length > 80 || !/^[a-zA-Z0-9_. -]*$/.test(raw.source))) {
    errors.form = "Invalid survey source.";
  }
  if (Object.keys(errors).length) return { errors };
  return { errors, submission: { submissionId: raw.submissionId as string, answers, ...(raw.source ? { source: (raw.source as string).trim() } : {}) } };
}

export function surveyCsvCell(value: string | number): string {
  const text = String(value);
  // Prevent spreadsheet formulas from respondent-controlled text.
  const safe = /^[\s]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}
