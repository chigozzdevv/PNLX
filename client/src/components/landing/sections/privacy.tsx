import { BadgeCheck, LockKeyhole, Shield } from "lucide-react";
import { landingFeatureRows } from "@/data/landing-content";

const featureIcons = [LockKeyhole, Shield, BadgeCheck];
const phoneFields = [
  ["Private Margin", "100 USDC"],
  ["Order Type", "Market"],
  ["Position Size", "0.016 BTC"],
  ["Leverage", "10x"],
];
export function LandingPrivacySection() {
  return (
    <section className="landing-privacy-section">
      <div className="landing-privacy-copy">
        <h2>
          Private order flow.
          <br />
          Verifiable settlement.
        </h2>

        <div className="landing-privacy-list">
          {landingFeatureRows.map((feature, index) => {
            const Icon = featureIcons[index] ?? Shield;

            return (
              <article className="landing-privacy-row" key={feature.title}>
                <span>
                  <Icon size={22} />
                </span>
                <p>
                  <strong>{feature.title}</strong> {feature.body}
                </p>
              </article>
            );
          })}
        </div>
      </div>

      <div className="landing-phone-stage" aria-hidden="true">
        <div className="landing-phone">
          <div className="landing-phone-top">
            <span>9:41</span>
            <div>
              <i />
              <i />
              <i />
            </div>
          </div>

          <div className="landing-phone-asset">
            <span>
              <LockKeyhole size={22} />
            </span>
            <div>
              <strong>Private Intent</strong>
              <em>Long BTC/USD</em>
            </div>
          </div>

          <div className="landing-phone-value">0.016 BTC</div>

          <div className="landing-phone-grid">
            {phoneFields.map(([label, value]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>

          <button className="landing-phone-submit" type="button">
            <span>Submit Long</span>
          </button>
        </div>
      </div>
    </section>
  );
}
