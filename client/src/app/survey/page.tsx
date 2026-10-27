import type { Metadata } from "next";
import { TraderSurvey } from "@/components/survey/trader-survey";

export const metadata: Metadata = {
  title: "Trader Survey | PNLX",
  description: "PNLX trader survey.",
};

export default function SurveyPage() {
  return <TraderSurvey />;
}
