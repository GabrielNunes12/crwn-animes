import { Link } from "react-router";
import { Reveal } from "../../components/Reveal/Reveal.jsx";
import { useTitle } from "../../hooks/useTitle.js";
import { useT } from "../../i18n/useT.js";
import styles from "./Privacy.module.css";

const DATA_ROWS = ["users", "sessions", "tokens", "ratings", "activity"];
const DEVICE_ROWS = ["progress", "prefs"];
const RIGHTS = ["access", "rectify", "erase", "object", "complain"];

export function Component() {
  const { t } = useT();
  useTitle(t("privacy.title"), t("meta.privacy"));

  return (
    <article className={`container ${styles.page}`}>
      <header className={styles.head}>
        <p className={styles.kicker}>{t("privacy.kicker")}</p>
        <h1>{t("privacy.title")}</h1>
        <p className={styles.lead}>{t("privacy.lead")}</p>
        <p className="hint">{t("privacy.updated")}</p>
      </header>

      <nav aria-label={t("privacy.toc")} className={styles.toc}>
        <ol>
          {["short", "keep", "device", "cookies", "youtube", "email", "basis", "rights", "security", "contact"].map((id) => (
            <li key={id}>
              <a href={`#${id}`}>{t(`privacy.${id}.title`)}</a>
            </li>
          ))}
        </ol>
      </nav>

      <Reveal as="section" variant="scroll" id="short" className={styles.highlight} aria-labelledby="short-h">
        <h2 id="short-h">{t("privacy.short.title")}</h2>
        <ul>
          {[1, 2, 3, 4, 5].map((n) => (
            <li key={n}>{t(`privacy.short.p${n}`)}</li>
          ))}
        </ul>
      </Reveal>

      <section id="keep" aria-labelledby="keep-h">
        <h2 id="keep-h">{t("privacy.keep.title")}</h2>
        <p>{t("privacy.keep.intro")}</p>
        <div className={styles.tableWrap} tabIndex={0} role="region" aria-label={t("privacy.keep.title")}>
          <table className={styles.table}>
            <caption className="visually-hidden">{t("privacy.keep.title")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("privacy.keep.colWhat")}</th>
                <th scope="col">{t("privacy.keep.colWhy")}</th>
                <th scope="col">{t("privacy.keep.colHowLong")}</th>
              </tr>
            </thead>
            <tbody>
              {DATA_ROWS.map((r) => (
                <tr key={r}>
                  <th scope="row">
                    <strong>{t(`privacy.keep.${r}.name`)}</strong>
                    <span className={styles.cellHint}>{t(`privacy.keep.${r}.what`)}</span>
                  </th>
                  <td>{t(`privacy.keep.${r}.why`)}</td>
                  <td>{t(`privacy.keep.${r}.until`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>{t("privacy.never")}</p>
      </section>

      <section id="device" aria-labelledby="device-h">
        <h2 id="device-h">{t("privacy.device.title")}</h2>
        <p>{t("privacy.device.intro")}</p>
        <ul>
          {DEVICE_ROWS.map((r) => (
            <li key={r}>{t(`privacy.device.${r}`)}</li>
          ))}
        </ul>
        <p>
          {t("privacy.device.clear")} <Link to="/account">{t("privacy.device.clearLink")}</Link>
        </p>
      </section>

      <section id="cookies" aria-labelledby="cookies-h">
        <h2 id="cookies-h">{t("privacy.cookies.title")}</h2>
        <p>{t("privacy.cookies.p1")}</p>
        <p>{t("privacy.cookies.p2")}</p>
      </section>

      <section id="youtube" aria-labelledby="youtube-h">
        <h2 id="youtube-h">{t("privacy.youtube.title")}</h2>
        <p>{t("privacy.youtube.p1")}</p>
        <p>{t("privacy.youtube.p2")}</p>
        <p>{t("privacy.youtube.p3")}</p>
      </section>

      <section id="email" aria-labelledby="email-h">
        <h2 id="email-h">{t("privacy.email.title")}</h2>
        <p>{t("privacy.email.p1")}</p>
      </section>

      <section id="basis" aria-labelledby="basis-h">
        <h2 id="basis-h">{t("privacy.basis.title")}</h2>
        <ul>
          <li>{t("privacy.basis.contract")}</li>
          <li>{t("privacy.basis.consent")}</li>
          <li>{t("privacy.basis.legit")}</li>
        </ul>
      </section>

      <section id="rights" aria-labelledby="rights-h">
        <h2 id="rights-h">{t("privacy.rights.title")}</h2>
        <p>{t("privacy.rights.intro")}</p>
        <dl className={styles.rights}>
          {RIGHTS.map((r) => (
            <div key={r} className={styles.right}>
              <dt>{t(`privacy.rights.${r}.name`)}</dt>
              <dd>{t(`privacy.rights.${r}.how`)}</dd>
            </div>
          ))}
        </dl>
        <p className="cluster">
          <Link className="btn btn-primary btn-sm" to="/account">
            {t("privacy.rights.cta")}
          </Link>
        </p>
      </section>

      <section id="security" aria-labelledby="security-h">
        <h2 id="security-h">{t("privacy.security.title")}</h2>
        <p>{t("privacy.security.p1")}</p>
      </section>

      <section id="contact" aria-labelledby="contact-h">
        <h2 id="contact-h">{t("privacy.contact.title")}</h2>
        <p>{t("privacy.contact.p1")}</p>
      </section>
    </article>
  );
}
