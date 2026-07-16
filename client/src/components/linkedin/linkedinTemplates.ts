/** Curated starter templates for LinkedIn campaign steps.
 *
 *  The *bodies* live in the locale files under `research.linkedin.camp.templates.*`
 *  (TR + EN) so they localise; this module only references the i18n keys. A step editor
 *  resolves the keys via `t()` when a template is applied. Template bodies must be
 *  resolved with interpolation disabled so `{{spintax}}` survives (i18next would
 *  otherwise treat `{{…}}` as a variable). */

export interface StarterTemplate {
    id: string;
    mode: 'off' | 'sections' | 'full';
    stepType: 'invite' | 'message';
    /** i18n key for the human-readable name shown in the picker. */
    nameKey: string;
    /** i18n key for the literal template body (off + sections modes). */
    templateKey?: string;
    /** i18n key for the full-AI prompt (full mode). */
    promptKey?: string;
    /** Sections (sections mode): the template references each as `{ai:key}`. */
    sections?: Array<{ key: string; promptKey: string }>;
}

const P = 'research.linkedin.camp.templates';

export const STARTER_TEMPLATES: StarterTemplate[] = [
    // ── off mode: literal, no AI ────────────────────────────────────────────────
    {
        id: 'off_invite', mode: 'off', stepType: 'invite',
        nameKey: `${P}.offInvite.name`, templateKey: `${P}.offInvite.body`,
    },
    {
        id: 'off_message', mode: 'off', stepType: 'message',
        nameKey: `${P}.offMessage.name`, templateKey: `${P}.offMessage.body`,
    },
    {
        id: 'off_followup', mode: 'off', stepType: 'message',
        nameKey: `${P}.offFollowup.name`, templateKey: `${P}.offFollowup.body`,
    },
    // ── sections mode: template + one AI section ────────────────────────────────
    {
        id: 'sections_icebreaker', mode: 'sections', stepType: 'message',
        nameKey: `${P}.sectionsIcebreaker.name`, templateKey: `${P}.sectionsIcebreaker.body`,
        sections: [{ key: 'icebreaker', promptKey: `${P}.sectionsIcebreaker.icebreaker` }],
    },
    {
        id: 'sections_followup', mode: 'sections', stepType: 'message',
        nameKey: `${P}.sectionsFollowup.name`, templateKey: `${P}.sectionsFollowup.body`,
        sections: [{ key: 'deger_onerisi', promptKey: `${P}.sectionsFollowup.degerOnerisi` }],
    },
    // ── full mode: AI writes the whole message ──────────────────────────────────
    {
        id: 'full_invite', mode: 'full', stepType: 'invite',
        nameKey: `${P}.fullInvite.name`, promptKey: `${P}.fullInvite.prompt`,
    },
    {
        id: 'full_message', mode: 'full', stepType: 'message',
        nameKey: `${P}.fullMessage.name`, promptKey: `${P}.fullMessage.prompt`,
    },
    {
        id: 'full_followup', mode: 'full', stepType: 'message',
        nameKey: `${P}.fullFollowup.name`, promptKey: `${P}.fullFollowup.prompt`,
    },
];
