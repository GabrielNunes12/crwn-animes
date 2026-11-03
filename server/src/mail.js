import nodemailer from "nodemailer";

// Sends the few e-mails the site needs. With SMTP_HOST set, mail goes out
// through SMTP. Without it (local development, tests) messages are kept in an
// in-memory outbox (the last 50, exposed at GET /api/dev/outbox outside
// production) and, outside production, links are printed to the console.
// Recipients are never logged (index.js refuses to start in production without SMTP).

export const LOCALES = ["pt-BR", "en"];
export const DEFAULT_LOCALE = "pt-BR";
const OUTBOX_SIZE = 50;

const COLORS = { background: "#0b0b14", card: "#15152a", accent: "#ff5c9a", text: "#f3f1fa", muted: "#a9a6bd" };

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Wraps paragraphs (and an optional button) in the dark, inline-styled layout. */
function layout({ locale, heading, paragraphs, button, footer }) {
  const p = (text) =>
    `<p style="margin:0 0 16px;font-size:16px;line-height:1.5;color:${COLORS.text};">${text}</p>`;
  const buttonHtml = button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;"><tr><td style="border-radius:8px;background:${COLORS.accent};">
         <a href="${escapeHtml(button.url)}" style="display:inline-block;padding:14px 28px;font-size:16px;font-weight:bold;color:#0b0b14;text-decoration:none;border-radius:8px;">${escapeHtml(button.label)}</a>
       </td></tr></table>
       <p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:${COLORS.muted};">${escapeHtml(button.fallback)}<br>
         <a href="${escapeHtml(button.url)}" style="color:${COLORS.accent};word-break:break-all;">${escapeHtml(button.url)}</a></p>`
    : "";
  return `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(heading)}</title></head>
<body style="margin:0;padding:0;background:${COLORS.background};font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.background};padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${COLORS.card};border-radius:12px;padding:32px;">
        <tr><td>
          <p style="margin:0 0 24px;font-size:20px;font-weight:bold;color:${COLORS.accent};">Crwn Animes</p>
          <h1 style="margin:0 0 16px;font-size:22px;color:${COLORS.text};">${escapeHtml(heading)}</h1>
          ${paragraphs.map((text) => p(escapeHtml(text))).join("\n          ")}
          ${buttonHtml}
          <p style="margin:24px 0 0;font-size:12px;line-height:1.5;color:${COLORS.muted};">${escapeHtml(footer)}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function textVersion({ heading, paragraphs, button, footer }) {
  const parts = ["Crwn Animes", "", heading, "", ...paragraphs.flatMap((t) => [t, ""])];
  if (button) parts.push(`${button.label}: ${button.url}`, "");
  parts.push(footer);
  return parts.join("\n");
}

const COPY = {
  "pt-BR": {
    footer: "Você recebeu este e-mail porque este endereço foi usado no Crwn Animes. Se não foi você, pode ignorá-lo.",
    fallback: "Se o botão não funcionar, copie e cole este link no navegador:",
    verify: (name) => ({
      subject: "Confirme seu e-mail no Crwn Animes",
      heading: `Olá, ${name}!`,
      paragraphs: [
        "Falta pouco: confirme seu e-mail para ativar sua conta e começar a avaliar episódios e capítulos.",
        "Ao abrir o link, vamos pedir a senha que você escolheu no cadastro. O link expira em 24 horas.",
      ],
      label: "Confirmar e-mail",
    }),
    registerAttempt: () => ({
      subject: "Tentativa de cadastro com o seu e-mail",
      heading: "Alguém tentou criar uma conta com este e-mail",
      paragraphs: [
        "Recebemos um pedido de cadastro no Crwn Animes com este endereço, mas ele já tem uma conta.",
        "Se foi você, entre com sua senha ou use \"Esqueci minha senha\" na tela de login. Se não foi, pode ignorar este e-mail: nada mudou na sua conta.",
      ],
      label: "Ir para o login",
    }),
    welcome: (name) => ({
      subject: "Bem-vindo(a) ao Crwn Animes",
      heading: `Conta confirmada, ${name}!`,
      paragraphs: ["Seu e-mail foi confirmado. Agora você pode avaliar episódios e capítulos e reagir a eles.", "Bons animes!"],
      label: "Abrir o Crwn Animes",
    }),
    reset: (name) => ({
      subject: "Redefina sua senha do Crwn Animes",
      heading: `Olá, ${name}`,
      paragraphs: ["Recebemos um pedido para redefinir a senha da sua conta.", "O link vale por 1 hora e só pode ser usado uma vez. Se não foi você, ignore este e-mail: sua senha continua a mesma."],
      label: "Criar nova senha",
    }),
    passwordChanged: (name) => ({
      subject: "Sua senha do Crwn Animes foi alterada",
      heading: `Olá, ${name}`,
      paragraphs: ["A senha da sua conta acabou de ser alterada e todas as outras sessões foram encerradas.", "Se não foi você, redefina sua senha agora pelo link abaixo."],
      label: "Redefinir senha",
    }),
  },
  en: {
    footer: "You received this e-mail because this address was used on Crwn Animes. If it wasn't you, you can ignore it.",
    fallback: "If the button doesn't work, copy and paste this link into your browser:",
    verify: (name) => ({
      subject: "Confirm your e-mail on Crwn Animes",
      heading: `Hi ${name}!`,
      paragraphs: [
        "Almost there: confirm your e-mail to activate your account and start rating episodes and chapters.",
        "When you open the link, you'll be asked for the password you chose when signing up. This link expires in 24 hours.",
      ],
      label: "Confirm e-mail",
    }),
    registerAttempt: () => ({
      subject: "Someone tried to sign up with your e-mail",
      heading: "Someone tried to create an account with this e-mail",
      paragraphs: [
        "We received a sign-up request on Crwn Animes with this address, but it already has an account.",
        "If it was you, log in with your password or use \"Forgot password\" on the login page. If it wasn't, you can ignore this e-mail: nothing changed on your account.",
      ],
      label: "Go to login",
    }),
    welcome: (name) => ({
      subject: "Welcome to Crwn Animes",
      heading: `You're all set, ${name}!`,
      paragraphs: ["Your e-mail is confirmed. You can now rate and react to episodes and chapters.", "Enjoy!"],
      label: "Open Crwn Animes",
    }),
    reset: (name) => ({
      subject: "Reset your Crwn Animes password",
      heading: `Hi ${name}`,
      paragraphs: ["We received a request to reset your account's password.", "The link is valid for 1 hour and can be used once. If it wasn't you, ignore this e-mail: your password stays the same."],
      label: "Choose a new password",
    }),
    passwordChanged: (name) => ({
      subject: "Your Crwn Animes password was changed",
      heading: `Hi ${name}`,
      paragraphs: ["Your account's password was just changed and every other session was signed out.", "If this wasn't you, reset your password now with the link below."],
      label: "Reset password",
    }),
  },
};

/**
 * Builds { subject, text, html } for one e-mail.
 * kind: verify | registerAttempt | welcome | reset | passwordChanged
 */
export function renderEmail(kind, { locale = DEFAULT_LOCALE, displayName = "", url }) {
  const copy = COPY[LOCALES.includes(locale) ? locale : DEFAULT_LOCALE];
  const { subject, heading, paragraphs, label } = copy[kind](displayName);
  const content = {
    locale,
    heading,
    paragraphs,
    footer: copy.footer,
    button: url ? { label, url, fallback: copy.fallback } : null,
  };
  return { subject, text: textVersion(content), html: layout(content) };
}

/**
 * mailer.send({ to, subject, text, html }) and mailer.outbox (null with SMTP).
 */
export function createMailer(config, { log = console.log } = {}) {
  if (config.smtp) {
    const transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
    return {
      outbox: null,
      async send(message) {
        await transport.sendMail({ from: config.mailFrom, ...message });
      },
    };
  }

  const outbox = [];
  return {
    outbox,
    async send({ to, subject, text, html }) {
      outbox.push({ to, subject, text, html, sentAt: new Date().toISOString() });
      if (outbox.length > OUTBOX_SIZE) outbox.splice(0, outbox.length - OUTBOX_SIZE);
      // A tokenised link is a password-equivalent: only print it in development.
      const link = config.isProduction ? null : text.match(/https?:\/\/\S+[?&]token=\S+/)?.[0];
      log(`[mail] (no SMTP configured) "${subject}"${link ? `\n[mail] link: ${link}` : ""}`);
    },
  };
}
