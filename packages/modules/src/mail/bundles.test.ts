// The bundle rules on mail as it really comes: people, people behind no-reply addresses, shops,
// GitHub, newsletters, lists, invitations and your own mail. Pure: no database (bundles-sync.test.ts
// has sync and the actions).
import { describe, expect, it } from "vitest";
import { type BundleFacts, type BundleMessage, bundleOf, categoryOf, factsOf } from "./bundles.ts";

const PERSONAL = ["INBOX", "UNREAD", "CATEGORY_PERSONAL"];
const UPDATES = ["INBOX", "UNREAD", "CATEGORY_UPDATES"];
const PROMOTIONS = ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"];
const SOCIAL = ["INBOX", "UNREAD", "CATEGORY_SOCIAL"];
const FORUMS = ["INBOX", "UNREAD", "CATEGORY_FORUMS"];

/** A message from someone else, as the rules see it, with what's given changed. */
const mail = (f: Partial<BundleFacts>): BundleFacts => ({
  youWrote: false,
  invite: false,
  from: "someone@example.com",
  replyTo: null,
  subject: "Hello",
  labels: PERSONAL,
  bulk: false,
  known: false,
  replyKnown: false,
  noise: false,
  tabNoise: false,
  colleague: false,
  toTeam: false,
  discussion: false,
  ...f,
});

describe("bundleOf", () => {
  it("puts mail you sent in People, whatever else it looks like", () => {
    expect(bundleOf(mail({ youWrote: true }))).toBe("people");
    // You wrote to a shop's help desk, and its answer came from a no-reply address.
    expect(
      bundleOf(
        mail({
          youWrote: true,
          from: "no-reply@help.shop.example",
          subject: "Re: Your order #4411",
          labels: UPDATES,
          bulk: true,
        }),
      ),
    ).toBe("people");
  });

  it("puts a calendar invitation in People, even where Gmail files it under Updates", () => {
    expect(
      bundleOf(
        mail({
          invite: true,
          from: "boss@work.example",
          subject: "Invitation: Planning @ Mon Oct 5, 3pm",
          labels: UPDATES,
        }),
      ),
    ).toBe("people");
  });

  it("puts someone you know in People, even where Gmail files them under Updates", () => {
    expect(bundleOf(mail({ from: "ana@friends.example", known: true }))).toBe("people");
    expect(bundleOf(mail({ from: "ana@friends.example", known: true, labels: UPDATES }))).toBe(
      "people",
    );
    // A stranger writing to you as a person is People too: a real conversation, maybe a new one.
    expect(bundleOf(mail({ from: "cy@else.example", subject: "Quick question" }))).toBe("people");
  });

  it("puts a person writing through a no-reply address in People", () => {
    // A contact form: from the site's no-reply address, Reply-To the person who wrote.
    const form = mail({
      from: "noreply@forms.sitebuilder.example",
      replyTo: "jane.doe@gmail.com",
      subject: "New message from your website",
    });
    expect(bundleOf(form)).toBe("people");
    // Someone you know, through a service that sends as itself: People wherever Gmail files it.
    expect(
      bundleOf(
        mail({
          from: "notifications@docs.example",
          replyTo: "ana@friends.example",
          replyKnown: true,
          subject: "Ana left a comment",
          labels: UPDATES,
        }),
      ),
    ).toBe("people");
    // A service's own Reply-To is the service, not a person.
    expect(bundleOf(mail({ ...form, replyTo: "reply+abc@reply.forms.sitebuilder.example" }))).toBe(
      "updates",
    );
    // And a stranger's Reply-To through a no-reply address, sent to many, is a mailing.
    expect(bundleOf(mail({ ...form, bulk: true, labels: PROMOTIONS }))).toBe("newsletters");
  });

  it("puts a receipt from Amazon in Receipts, and its shipping notice in Updates", () => {
    const amazon = mail({
      from: "auto-confirm@amazon.com",
      subject: 'Your Amazon.com order of "The Pragmatic Programmer"',
      labels: UPDATES,
    });
    expect(bundleOf(amazon)).toBe("receipts");
    // Gmail gave it no tab: the shop's name is enough.
    expect(bundleOf({ ...amazon, labels: ["INBOX"] })).toBe("receipts");
    expect(
      bundleOf({ ...amazon, from: "shipment-tracking@amazon.com", subject: "Shipped: 1 item" }),
    ).toBe("updates");
    expect(
      bundleOf({
        ...amazon,
        subject: "Your Amazon.com order #112-5551234-0000001 is out for delivery",
      }),
    ).toBe("updates");
  });

  it("puts receipts and invoices from shops and services in Receipts", () => {
    const cases: [string, string, string[]][] = [
      ["no_reply@email.apple.com", "Your receipt from Apple.", ["INBOX"]],
      ["receipts+acct_1x2y@stripe.com", "Your receipt from Acme Inc #2210-4471", UPDATES],
      ["invoice+statements@mail.vercel.example", "Your invoice for October", UPDATES],
      ["service@paypal.com", "You sent a payment to Sam Lee", UPDATES],
      ["orders@tinyshop.example", "Order confirmation #1042", PERSONAL],
      ["noreply@github.com", "[GitHub] Payment Receipt for owner", UPDATES],
    ];
    for (const [from, subject, labels] of cases)
      expect([from, bundleOf(mail({ from, subject, labels }))]).toEqual([from, "receipts"]);
  });

  it("leaves an invoice a person you know writes themselves in People, wherever they work", () => {
    expect(
      bundleOf(mail({ from: "jo@studio.example", known: true, subject: "Invoice for September" })),
    ).toBe("people");
    // Gmail files it under Updates: still Jo.
    expect(
      bundleOf(
        mail({
          from: "jo@studio.example",
          known: true,
          subject: "Invoice for September",
          labels: UPDATES,
        }),
      ),
    ).toBe("people");
    // Jane works at Stripe, a shop by name, and writes from her own address.
    const jane = mail({
      from: "jane@stripe.com",
      known: true,
      subject: "Invoice question",
      labels: UPDATES,
    });
    expect(bundleOf(jane)).toBe("people");
    expect(bundleOf({ ...jane, subject: "Your order shipped? Re the demo kit" })).toBe("people");
    // Stripe's own receipts are receipts, even with the address in your people.
    const receipt = "Your receipt from Acme Inc #2210-4471";
    for (const from of ["receipts+acct_1x2y@stripe.com", "no-reply@stripe.com"])
      expect([from, bundleOf({ ...jane, from, subject: receipt })]).toEqual([from, "receipts"]);
  });

  it("puts a GitHub notification in Updates, even when it names a receipt", () => {
    const github = mail({
      from: "notifications@github.com",
      replyTo: "reply+ABCD1234@reply.github.com",
      subject: "Re: [acme/web] Fix invoice export (PR #42)",
      labels: UPDATES,
      bulk: true,
    });
    expect(bundleOf(github)).toBe("updates");
    expect(bundleOf({ ...github, labels: FORUMS })).toBe("updates");
    expect(bundleOf({ ...github, subject: "[acme/web] Receipts page is blank (Issue #7)" })).toBe(
      "updates",
    );
    // A tracker that isn't a no-reply address, under its tag: talk about receipts, not one.
    expect(
      bundleOf(
        mail({
          from: "jira@acme.atlassian.net",
          subject: "[JIRA] (WEB-12) Receipt upload fails",
          labels: UPDATES,
          bulk: true,
        }),
      ),
    ).toBe("updates");
  });

  it("puts accounts and alerts in Updates", () => {
    const cases: [string, string, string[], boolean][] = [
      ["no-reply@accounts.google.com", "Security alert", UPDATES, false],
      ["noreply@service.example", "Reset your password", PERSONAL, false],
      ["notifications@vercel.com", "Failed production deployment on acme-web", UPDATES, true],
      ["messages-noreply@linkedin.com", "Jane sent you a message", SOCIAL, true],
      ["calendar-notification@google.com", "Reminder: Planning at 3pm", ["INBOX"], false],
      ["team@status.example", "Scheduled maintenance tonight", UPDATES, true],
    ];
    for (const [from, subject, labels, bulk] of cases)
      expect([from, bundleOf(mail({ from, subject, labels, bulk }))]).toEqual([from, "updates"]);
  });

  it("puts a newsletter in Newsletters, even one from a person you know", () => {
    // Jane, whom you've written to, sends her newsletter from her own address.
    expect(
      bundleOf(
        mail({
          from: "jane@janedoe.example",
          known: true,
          subject: "Issue 12: what I learned shipping alone",
          bulk: true,
        }),
      ),
    ).toBe("newsletters");
    // Through a newsletter service, wherever Gmail files it.
    expect(
      bundleOf(
        mail({ from: "platformer@substack.com", subject: "The week", labels: UPDATES, bulk: true }),
      ),
    ).toBe("newsletters");
    expect(bundleOf(mail({ from: "news@company.example", subject: "October news" }))).toBe(
      "newsletters",
    );
  });

  it("puts marketing and lists in Newsletters", () => {
    expect(
      bundleOf(
        mail({ from: "deals@shop.example", subject: "50% off everything", labels: PROMOTIONS }),
      ),
    ).toBe("newsletters");
    // A sale isn't a receipt for being from a shop, nor a shipment for offering free shipping.
    expect(
      bundleOf(
        mail({
          from: "hello@shop.example",
          subject: "Free shipping on every order this week",
          labels: PROMOTIONS,
          bulk: true,
        }),
      ),
    ).toBe("newsletters");
    // A list's discussion, by someone you don't know, even about receipts.
    expect(
      bundleOf(
        mail({
          from: "sam@gmail.com",
          subject: "[book-club] Receipts from the trip",
          labels: FORUMS,
          bulk: true,
        }),
      ),
    ).toBe("newsletters");
    expect(bundleOf(mail({ from: "digest@medium.example", labels: PROMOTIONS, bulk: true }))).toBe(
      "newsletters",
    );
  });

  it("keeps a sender you sent to Noise out of People, till you write to them", () => {
    // A stranger, and even someone you know: Updates, or Newsletters when it went to many.
    expect(bundleOf(mail({ from: "cy@else.example", noise: true }))).toBe("updates");
    expect(bundleOf(mail({ from: "ana@friends.example", known: true, noise: true }))).toBe(
      "updates",
    );
    expect(bundleOf(mail({ from: "cy@else.example", bulk: true, noise: true }))).toBe(
      "newsletters",
    );
    // What isn't People stays where the rules put it.
    expect(
      bundleOf(
        mail({ from: "orders@tinyshop.example", subject: "Order confirmation #1042", noise: true }),
      ),
    ).toBe("receipts");
    // Writing in it is your word too, and the later one.
    expect(bundleOf(mail({ from: "cy@else.example", noise: true, youWrote: true }))).toBe("people");
  });
});

describe("factsOf", () => {
  const ME = "owner@example.com";
  const msg = (m: Partial<BundleMessage>): BundleMessage => ({
    outbound: false,
    fromAddress: "ana@friends.example",
    replyTo: null,
    subject: "Lunch?",
    labels: PERSONAL,
    bulk: null,
    invite: null,
    toAddresses: [{ address: ME }],
    ccAddresses: [],
    ...m,
  });

  it("reads the newest message from someone else, and whether you wrote", () => {
    const f = factsOf(
      [
        msg({}),
        msg({ outbound: true, fromAddress: ME, subject: "Re: Lunch?" }),
        msg({ subject: "Re: Lunch?", replyTo: "Ana@Friends.example", labels: UPDATES }),
      ],
      ME,
      new Set(["ana@friends.example"]),
    );
    expect(f).toEqual({
      youWrote: true,
      invite: false,
      from: "ana@friends.example",
      // Reply-To that's the sender again says nothing more.
      replyTo: null,
      subject: "Re: Lunch?",
      labels: UPDATES,
      bulk: false,
      known: true,
      replyKnown: false,
      noise: false,
      tabNoise: false,
      colleague: false,
      toTeam: false,
      discussion: false,
    });
    // The conversation's lane comes along.
    expect(factsOf([msg({})], ME, new Set(), true).noise).toBe(true);
  });

  it("counts your own email that reached this account as yours", () => {
    const f = factsOf([msg({ fromAddress: "Owner+notes@example.com" })], ME, new Set());
    expect(f.youWrote).toBe(true);
    expect(bundleOf(f)).toBe("people");
  });

  it("notices an invitation in any message, and a Reply-To you know", () => {
    const invite = {
      uid: "u1",
      method: "REQUEST",
      summary: "Planning",
      start: null,
      organizer: "",
    };
    const f = factsOf(
      [
        msg({ fromAddress: "boss@work.example", invite }),
        msg({ fromAddress: "noreply@docs.example", replyTo: "ana@friends.example", bulk: true }),
      ],
      ME,
      new Set(["ana@friends.example"]),
    );
    expect(f).toMatchObject({ invite: true, from: "noreply@docs.example", replyKnown: true });
    expect(f.bulk).toBe(true);
  });

  it("is People for a conversation with no messages left to read", () => {
    expect(bundleOf(factsOf([], ME, new Set()))).toBe("people");
  });
});

describe("categoryOf", () => {
  it("reads Gmail's tab from the labels, or none", () => {
    expect(categoryOf(PROMOTIONS)).toBe("promotions");
    expect(categoryOf(["INBOX", "STARRED"])).toBeNull();
  });
});
