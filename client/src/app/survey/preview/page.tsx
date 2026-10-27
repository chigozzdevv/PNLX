import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TraderSurvey } from "@/components/survey/trader-survey";

export const metadata: Metadata = {
  title: "Survey Thank-you Preview | PNLX",
  robots: { index: false, follow: false },
};

export default function SurveyConfirmationPreview() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <TraderSurvey previewConfirmation />;
}
