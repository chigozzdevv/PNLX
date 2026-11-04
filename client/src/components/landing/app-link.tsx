import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { APP_HOME_HREF } from "@/lib/app-url";
import styles from "./landing.module.css";

export function AppLink({ children }: { children: string }) {
  return (
    <Link href={APP_HOME_HREF} className={styles.launch}>
      {children}
      <ArrowUpRight size={15} aria-hidden="true" />
    </Link>
  );
}
