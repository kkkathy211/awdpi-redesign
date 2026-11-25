---
# Network privacy page: lists each organisation's privacy notice and explains how awdpi.org handles
# information about visitors. AWDPI United Kingdom runs the website, so it is the controller here.
# Keep "What happens when you visit" in step with what the site actually loads. Before launch:
# when the "Write to us" form on the Support us page is connected, add the service that delivers it.
# The Chinese version (content/zh-cn/privacy.md) is a translation; keep both in step.
# "The Avoice AI assistant" (added 2026-11-16) must be confirmed before launch: which AWDPI organisation operates
# the assistant and holds the AWS account (the Avoice plan names AWDPI Belgium, while this page names AWDPI United
# Kingdom as the website's controller); the UK GDPR Article 9 condition for sensitive information in messages; and
# a DPIA. Keep it in step with the relay (repository awdp-avoice/avoice-chat-relay).
# "BEACON mentoring" (added 2026-11-25) describes the platform in repository awdp-avoice/beacon; keep it in step with
# the code (retention periods in apps/api/src/domain/jobs.ts RETENTION_DAYS, store TTLs in apps/api/src/store/dynamo.ts,
# bucket lifecycle and log retention in infra/template.yaml). Before launch: (1) cover BEACON in the DPIA and the
# Schedule 1 policy document; (2) state BEACON's own address once it has one (beacon.awdpi.org).
title: Privacy
headTitle: Privacy | AWDPI
description: "How the AWDPI organisations handle personal information, and how awdpi.org handles information about visitors."
type: legal
layout: prose
lastUpdated: "2026-11-25"
---
AWDPI is an international network of independently registered non-profit organisations. Each organisation decides how it uses the personal information it collects, is responsible for it under the law of its own country, and has its own privacy notice:

{{< privacy-notices >}}

The notice that applies to you is the one of the organisation you deal with, usually the one in the country where you live. Each notice explains what the organisation collects, why, who it shares it with, how long it keeps it, your rights and how to complain.

This page explains how awdpi.org itself handles information about visitors.

## Who is responsible for the website

awdpi.org is run on behalf of the AWDPI network by **{{< org uk legalName >}}**, known as AWDPI United Kingdom. AWDPI United Kingdom is the controller of the personal data processed when you visit the website, under the UK General Data Protection Regulation (UK GDPR) and the Data Protection Act 2018. Its [privacy notice](/uk/privacy/) explains your rights and how to complain.

## What happens when you visit

The website does not use analytics, advertising or tracking tools, and it does not place cookies or use similar technologies, such as local storage, on your device. When you visit, some information is still processed so that the pages can reach you:

- **Hosting.** The website is hosted on GitHub Pages, a service of GitHub, Inc. in the United States. To deliver the pages and keep the service secure, GitHub processes technical information about your visit, such as your IP address and the pages you request, and may keep it in its server logs.
- **Fonts.** Our pages load fonts from Google Fonts, a service of Google. Your browser connects to Google's servers, which receive your IP address and information about your browser. Google Fonts does not set cookies.
- **Articles first published on WeChat.** Some older articles in our Stories section load images or videos from servers run by Tencent, which may be in mainland China. When you open one of these articles, your browser connects to those servers, which receive your IP address.

We use this information only to run a working, secure website. Our lawful basis is our legitimate interest in doing so (UK GDPR Article 6(1)(f)).

Because we do not track visitors, the website works the same way whether or not your browser sends a "Do Not Track" or "Global Privacy Control" signal.

## The Avoice AI assistant {#the-avoice-ai-assistant}

Every page has a chat window with the Avoice AI assistant. It is an automated service, not a person. It can explain the support AWDPI offers and point you to help services in your country. It does not give legal, medical or psychological advice and is not an emergency service.

- **What is sent.** When you send a message, your browser sends the conversation shown in the window (up to the last eight exchanges) to our service in the Amazon Web Services (AWS) data centre in Stockholm, Sweden. The service adds information from AWDPI's directory of help services and passes the conversation to an AI model (DeepSeek, run by AWS in the same region) to write the reply.
- **What is kept.** Nothing. The conversation exists only in the open page and is gone when you close, reload or leave it. We do not store your messages or the replies, do not record them in our logs, and have set the AI model service not to retain them. Our service keeps only counts, such as how many messages were answered and what they cost, and, for a few minutes, an irreversibly scrambled (hashed) form of your IP address to stop the service being flooded.
- **Web search.** Some replies end with links found by a monthly web search for public help services. The search uses only fixed terms, such as a city and a kind of service. It never includes anything you write and is not run when you ask a question.
- **Please do not share details that identify you**, such as your name, address or ID numbers. If you choose to describe what happened to you, your messages may include sensitive information, for example about your health or about violence against you. We use it only to reply to you and do not keep it.

AWS acts as our processor under a data processing agreement. Our lawful basis for running the assistant is our legitimate interest in giving people information about support (UK GDPR Article 6(1)(f)).

## BEACON mentoring {#beacon}

BEACON is AWDPI's mentoring programme. It runs as a separate web app at awdpi.org/BEACON, where members sign in, and carries the same notice inside the app. AWDPI United Kingdom is the controller of the personal data processed in BEACON. This section explains what BEACON processes; the AWDPI United Kingdom [privacy notice](/uk/privacy/) explains your rights and how to complain.

### What we process

- **Your account:** the e-mail address you sign in with (using a one-time code, without a password), and a record of when you agreed to the code of conduct and confirmed that you are 18 or over. BEACON is only for people aged 18 or over.
- **Your profile:** what you choose to show other members, such as your name, a one-line introduction, your school or organisation, country, city and time zone, languages, career directions, the help you want or offer, when you are free, and what you write about yourself. Mentors also set how many people they mentor and how often they meet.
- **Contact details** you add, such as WeChat, LinkedIn or a contact e-mail address. They are shown to someone you are matched with only after you both agree to exchange them.
- **Your mentoring:** requests you send or receive, messages between you and your match, meetings you book or record and their notes, shared goals, and the short check-ins you send to your coordinator.
- **Help and safety:** requests for help, reports about other members, and "I feel unsafe" requests, with anything you write in them.
- **Free access:** if you apply for priority on pro bono places, the category you choose, your short statement, and either a document you upload or the name and contact details of someone who can confirm your situation.
- **AI suggestions:** if you ask for suggestions by describing what you need, what you write.
- **Records of use:** the notifications we show or send you, and a log of staff actions, such as approving a request, opening a free-access document or opening a pair's messages.

### Who can see it

- Other members see your profile, within the visibility you choose: your chapter or the whole network. They never see your e-mail address, and they see your contact details only if you agree to exchange them.
- Only you and your match can read your messages and meeting notes.
- Coordinators see the requests and matches in the chapters or countries they look after, as status, dates and counts, and the check-ins and help requests sent to them. They cannot read your messages or meeting notes.
- Mentors see that a mentee holds a pro bono place, never the reason or the evidence. Only BEACON administrators review free-access applications, and each time one of them opens a document, it is logged.
- The safety lead or an administrator can read a pair's messages only while handling an "I feel unsafe" request about that match, and only after writing down why. This is logged.

Coordinators, the safety lead and administrators are AWDPI staff and volunteers. Some of them live outside the United Kingdom.

### How we use it and our lawful bases

- **To run the programme you joined:** suggesting mentors, requests, messages, meetings, notifications and e-mail reminders. Our lawful basis is that this is necessary for our agreement with you (UK GDPR Article 6(1)(b)).
- **To review requests, follow up pairs, prevent misuse, keep members safe and keep a record of staff actions.** Our lawful basis is our legitimate interest in running a safe programme (Article 6(1)(f)).
- **Sensitive information.** If a help request or a safety request includes information about your health, sex life or other special category data, we use it to keep you and others safe (Data Protection Act 2018, Schedule 1, paragraph 18, safeguarding of individuals at risk). If a free-access application includes such information, for example about a disability, we use it with your explicit consent (Article 9(2)(a)), which you give by ticking the consent box in the form. You can withdraw it at any time in BEACON; the application and its document are then deleted at once.
- **AI suggestions are only suggestions.** You decide whom to ask, and every request is answered by a person, so no decision about you is made solely by automated means.

### Where it is stored

All BEACON data is stored by Amazon Web Services (AWS) in its data centre in Stockholm, Sweden. This covers sign-in (Amazon Cognito), the database (Amazon DynamoDB), uploaded documents (Amazon S3, encrypted with our own key) and the e-mails BEACON sends (Amazon SES). BEACON's page files are served by GitHub Pages as part of the awdpi.org website. GitHub is a US company and, as with opening any web page, it processes access information such as your IP address; the page files themselves contain no personal data. What you enter and see in BEACON does not pass through GitHub: it travels directly between your browser and AWS in Stockholm.

AI suggestions use an AI model (DeepSeek) run by AWS in Stockholm. It receives what you write and the work-related parts of your profile and of mentors' profiles: directions, topics, languages, country and city, and the start of what each person wrote about themselves. It never receives names, e-mail addresses or contact details. AWS does not keep these requests, and we have not switched on logging of them.

AWS acts as our processor under a data processing agreement.

### How long we keep it

- **One-time sign-in codes:** 5 minutes.
- **Chapter verification codes:** 15 minutes.
- **Notifications:** 180 days.
- **Requests that never became a match** (declined, withdrawn, expired or sent back for more detail): 180 days after they closed.
- **Matches**, with their messages, meeting notes, goals and check-ins: 2 years after the match ends or is completed.
- **Help requests:** 2 years after they were made, once resolved. **Safety requests and reports:** 3 years after they were made, once closed, to protect people at risk.
- **Free-access documents:** deleted 30 days after the decision on your application; a document uploaded without an application being sent is deleted after 60 days. **The application itself:** 1 year after the decision.
- **The log of staff actions:** 2 years.
- **Technical logs**, which record requests but not what they contain: 14 days.
- **Database backups:** up to 35 days.
- **Your profile, contact details and settings:** while your account is open.

You can download your data at any time in BEACON under Me, then Settings. When you delete your account, we delete straight away your profile, contact details, settings, sign-in and notifications, your help requests, your free-access applications and documents, your check-ins, and any request that never became a match. In matches that ran, the conversation, meeting notes and goals stay with the other person, shown as coming from a deleted account, because they are that person's record too; they are deleted on the schedule above. Safety requests and reports you made are kept without your name until their period ends, to protect people at risk.

### On your device

BEACON keeps your sign-in session and your language choice in your browser's local storage, because the app needs them to work. BEACON does not use cookies, analytics or advertising tools.

## Transfers outside the United Kingdom

The AI assistant and BEACON run in Sweden, in the European Economic Area. UK regulations approve transfers of personal data to the European Economic Area. Some BEACON coordinators and administrators live outside the United Kingdom; they reach BEACON data only through the app and only as their role needs, and the safeguards described in the AWDPI United Kingdom [privacy notice](/uk/privacy/) apply.

GitHub, Google and Amazon Web Services are based in the United States. All three are certified under the Data Privacy Framework, and UK regulations approve transfers of personal data to certified US companies (the UK–US "data bridge").

No UK regulations approve transfers to China, and we have no agreement with Tencent. If you prefer that your browser does not connect to Tencent's servers, do not open the older articles that were first published on WeChat.

## Links and social media

The website links to other services, such as WeChat, WhatsApp, Instagram, LinkedIn and Facebook. When you use them, their own privacy policies apply. If you message an AWDPI organisation through one of them, that organisation handles your message under its own privacy notice.

## Questions

For questions about the website, write to [contact@awdpi.org](mailto:contact@awdpi.org). For questions about how an AWDPI organisation handles your information, write to that organisation; the addresses are in its privacy notice and on the [AWDPI organisations](/organisations/) page.

## Language

This page is also published in Chinese. If the two versions differ, the English version applies. The privacy notices of the AWDPI organisations are in English.

## Changes to this page

We update this page when the website or the law changes. The date below shows when it last changed.
