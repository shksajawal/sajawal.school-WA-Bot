/**
 * Deterministic FAQ responder — zero model tokens.
 *
 * Mined from 60 human-support transcripts plus the live bot's own chats: a
 * small set of questions accounts for most of what people ask, and every
 * answer is a fixed fact the owner has confirmed. Claude adds nothing to
 * "do you give a certificate" — so it never sees those.
 *
 * Deliberately conservative. It answers only when the message is short, maps
 * to exactly ONE topic, and carries no buying signal. Anything ambiguous,
 * layered, or close to money goes to Claude with full history.
 */

interface Faq {
  id: string;
  test: RegExp;
  en: string;
  ur: string;
}

/** Buying signals — never intercept these, they belong to the closer. */
const BUYING = /\b(bhej|bhaj|send (me )?(the )?(account|details|number)|ready|join kar|enroll|karwa|kar dun|kardo|karde|pay kar|payment kar|screenshot|receipt|transfer kar|start kar|le lun|lelo|chahiye)\b/i;

/** Roman-Urdu markers — decides which language the canned answer uses. */
const URDU = /\b(kya|kia|hai|hy|hain|ka|ke|ki|ko|se|mein|me|aur|ap|aap|nahi|nhi|kar|kr|kaise|kese|kitna|kitni|kitne|kab|kon|konsa|mujhe|mje|acha|theek|thk|ji|han|haan|batao|bata|dein|do)\b/i;

const FAQS: Faq[] = [
  {
    id: "duration",
    test: /\b(how long|duration|kitne? (din|hafte|mahine|weeks?|months?)|kitna time|time lag|8 week|complete)\b/i,
    en: "It's an 8 week program, but everything is recorded so you go at your own pace. 5 to 7 hours a week is enough, and access never expires.\n\nWhat are you aiming for, a job, freelancing, or your own business?",
    ur: "8 hafte ka program hai, lekin sab recorded hai to aap apni speed se kar sakte hain. Hafte mein 5 se 7 ghante kaafi hain, aur access kabhi khatam nahi hota.\n\nAap ka goal kya hai, job, freelancing ya apna business?",
  },
  {
    id: "live_or_recorded",
    test: /\b(live|recorded|recording|zoom|class(es)?|lecture)\b/i,
    en: "Modules are recorded, so you start immediately and learn at your own pace. On top of that there are live calls once or twice a month, usually led by Sajawal with industry experts joining.\n\nLive attendance is part of Advance. Core includes all the call recordings.",
    ur: "Modules recorded hain, to aap foran start kar sakte hain apni speed se. Uske sath mahine mein aik ya do dafa live calls hoti hain, aksar Sajawal khud lete hain aur industry experts bhi aate hain.\n\nLive attend karna Advance mein hai. Core mein saari call recordings milti hain.",
  },
  {
    id: "certificate",
    test: /\bcertificate|certification|sanad\b/i,
    en: "Yes, a certificate is available on request once you're through the program.\n\nWhat are you looking to use the skills for?",
    ur: "Ji haan, program complete karne ke baad certificate request pe mil jata hai.\n\nAap ye skills kis cheez ke liye seekhna chah rahe hain?",
  },
  {
    id: "device",
    test: /\b(laptop|mobile|computer|pc|phone)\b.*\b(chahiye|zaroori|need|required|hoga|kaam|karun)\b|\b(need|required)\b.*\b(laptop|computer|pc)\b/i,
    en: "You can learn the whole thing on mobile. A laptop is ideally needed later, when you start doing actual client work.\n\nAre you starting from zero, or do you have some experience already?",
    ur: "Poori learning mobile pe ho sakti hai. Laptop aage chal ke behtar hota hai, jab aap actual client work start karte hain.\n\nAap bilkul zero se start kar rahe hain ya thora experience hai?",
  },
  {
    id: "language",
    test: /\b(language|urdu|english|zaban|zuban)\b/i,
    en: "Teaching is mostly in Urdu, with a little English here and there.\n\nWhat's your goal with this, job, freelancing, or your own business?",
    ur: "Parhai zyada tar Urdu mein hoti hai, thori bohat English aa jati hai.\n\nAap ka goal kya hai, job, freelancing ya apna business?",
  },
  {
    id: "beginner",
    test: /\b(beginner|zero se|bilkul naya|no experience|experience nahi|newbie|shuru se|start from (zero|scratch))\b/i,
    en: "Completely fine, it's built for beginners. No experience needed, no age limit, and it goes from the basics all the way to advanced.\n\nWhat are you hoping to do with it, freelancing, a job, or your own business?",
    ur: "Bilkul theek hai, ye beginners ke liye hi bana hai. Koi experience ki zaroorat nahi, koi age limit nahi, aur basics se le kar advance tak jata hai.\n\nAap is se kya karna chahte hain, freelancing, job ya apna business?",
  },
  {
    id: "installments",
    test: /\b(installment|instalment|qist|kisht|do baar|two payments|half now|adha)\b/i,
    en: "Installments aren't available, it's a single one time payment with lifetime access.\n\nCore is Rs 3,900. Should I send the account details?",
    ur: "Installment ka option nahi hai, aik hi baar ki payment hai aur lifetime access mil jata hai.\n\nCore Rs 3,900 hai. Account details bhej doon?",
  },
  {
    id: "trial",
    test: /\b(free trial|trial|demo|free mein|muft|try free)\b/i,
    en: "There's no free trial, but there is a 2 day money back guarantee. Join, go through it, and if it's not for you just send one message and you get a full refund.\n\nWant me to send the details?",
    ur: "Free trial to nahi hai, lekin 2 din ki money back guarantee hai. Join karein, dekh lein, agar theek na lage to aik message pe poora refund mil jata hai.\n\nDetails bhej doon?",
  },
  {
    id: "youtube",
    test: /\byoutube|yt ads\b/i,
    en: "YouTube is covered inside the Google Ads module.\n\nAre you looking at this for clients, or for your own business?",
    ur: "YouTube Google Ads module ke andar cover hota hai.\n\nAap clients ke liye dekh rahe hain ya apne business ke liye?",
  },
  {
    id: "ai_module",
    test: /\b(ai|artificial intelligence)\b.*\b(module|session|cover|sikh|seekh|related|kya)\b|\bai marketing\b/i,
    en: "There's an AI Marketing module with a recent session on using AI properly, how the tools actually work, and using them for marketing and growth. More sessions are coming on specific tools and use cases like automation and content.\n\nIt's part of the Advance plan.",
    ur: "AI Marketing module hai, ismein aik recent session hai ke AI ko sahi tarah kaise use karna hai, tools kaise kaam karte hain, aur marketing aur growth mein kaise lagana hai. Aage aur sessions aa rahe hain automation aur content jaise use cases pe.\n\nYe Advance plan ka hissa hai.",
  },
  {
    id: "sajawal_direct",
    test: /\b(sajawal|shaikh|sheikh)\b.*\b(baat|talk|direct|khud|contact|milna)\b|\b(talk|speak) to sajawal\b/i,
    en: "Sajawal is active inside the community, and he leads most of the live calls. On WhatsApp you're talking to the team.\n\nOne on one mentorship is a separate thing, I can pass that to the team if you want.",
    ur: "Sajawal community ke andar active rehte hain, aur zyada tar live calls wo khud lete hain. WhatsApp pe aap team se baat kar rahe hain.\n\nOne on one mentorship alag cheez hai, chahein to main team ko bata deta hoon.",
  },
  {
    id: "done_for_you",
    test: /\b(ads chala|run (my |our )?ads|manage (my |our )?(ads|campaign)|service|agency|kaam kar do|aap kar)\b.*\b(mere|meri|hamare|for me|for us|do|dein)\b/i,
    en: "We teach it here rather than run it for you. For agency services, the right place is www.revzo.ai, that's Sajawal's performance marketing agency.\n\nIf you'd rather learn to run them yourself, that's exactly what this program is.",
    ur: "Yahan hum sikhate hain, khud chalate nahi. Agency services ke liye sahi jagah www.revzo.ai hai, ye Sajawal ki performance marketing agency hai.\n\nAgar aap khud chalana seekhna chahte hain to program bilkul isi ke liye hai.",
  },
];

export interface FaqHit {
  id: string;
  reply: string;
}

/**
 * Returns a canned answer when this message is unambiguously one known
 * question, otherwise null (Claude handles it).
 */
export function matchFaq(body: string): FaqHit | null {
  const text = body.trim();
  if (text.length < 4 || text.length > 140) return null;
  if (BUYING.test(text)) return null;

  const hits = FAQS.filter((f) => f.test.test(text));
  if (hits.length !== 1) return null; // zero or ambiguous -> Claude

  const f = hits[0];
  return { id: f.id, reply: URDU.test(text) ? f.ur : f.en };
}
