import { Router, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireRole } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { createLogger } from '../lib/logger.js';
import { translateTexts } from '../lib/deepl.js';
import { validateBody, createContactSchema, updateContactSchema, contactNoteSchema } from '../lib/validation.js';

const log = createLogger('route:contacts');

interface ContactNote {
    id: string;
    text: string;
    created_at: string;
    created_by: string;
}

/** Parse notes from DB — handles both JSONB (array) and TEXT (JSON string) formats */
function parseNotes(raw: unknown): ContactNote[] {
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return parsed;
        } catch { /* not JSON */ }
    }
    return [];
}

// Sanitize search input for safe use in PostgREST .or() filter strings.
function sanitizeSearch(value: string): string {
    return value.replace(/[,().\\]/g, '');
}

const router = Router();

// GET /api/contacts/filter-options — distinct filter values for PeoplePage dropdowns
router.get('/filter-options', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;

        const [seniorityRes, countryRes, companyRes] = await Promise.all([
            supabaseAdmin
                .from('contacts')
                .select('seniority')
                .eq('tenant_id', tenantId)
                .not('seniority', 'is', null),
            supabaseAdmin
                .from('contacts')
                .select('country')
                .eq('tenant_id', tenantId)
                .not('country', 'is', null),
            supabaseAdmin
                .from('companies')
                .select('id, name')
                .eq('tenant_id', tenantId)
                .order('name'),
        ]);

        const unique = <T>(arr: T[]): T[] => [...new Set(arr)];

        res.json({
            data: {
                seniorities: unique((seniorityRes.data || []).map((r: any) => r.seniority)).sort(),
                countries: unique((countryRes.data || []).map((r: any) => r.country)).sort(),
                companies: (companyRes.data || []).map((c: any) => ({ id: c.id, name: c.name })),
            },
        });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Filter options error');
        res.status(500).json({ error: 'Failed to fetch filter options' });
    }
});

// GET /api/contacts — List contacts with pagination, search, sort, filter
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const companyId = req.query.company_id as string | undefined;

        // When fetching for a company detail page (company_id provided), simple ordered list
        if (companyId) {
            const { data, error } = await supabaseAdmin
                .from('contacts')
                .select('*')
                .eq('tenant_id', tenantId)
                .eq('company_id', companyId)
                .order('is_primary', { ascending: false })
                .order('created_at', { ascending: true });

            if (error) {
                res.status(500).json({ error: 'Failed to fetch contacts' });
                return;
            }
            res.json({ data: data || [] });
            return;
        }

        // PeoplePage: full pagination + filtering
        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 25));
        const offset = (page - 1) * limit;
        const search = (req.query.search as string || '').trim();
        const sortBy = (req.query.sortBy as string) || 'updated_at';
        const sortOrder = req.query.sortOrder === 'asc';

        const filterCompanyIds = req.query.company_ids
            ? (req.query.company_ids as string).split(',').filter(Boolean)
            : [];
        const filterSeniorities = req.query.seniorities
            ? (req.query.seniorities as string).split(',').filter(Boolean)
            : [];
        const filterCountries = req.query.countries
            ? (req.query.countries as string).split(',').filter(Boolean)
            : [];

        const allowedSortFields = ['first_name', 'last_name', 'email', 'country', 'seniority', 'created_at', 'updated_at'];
        const safeSortBy = allowedSortFields.includes(sortBy) ? sortBy : 'updated_at';

        let query = supabaseAdmin
            .from('contacts')
            .select(`*, companies(id, name, stage)`, { count: 'exact' })
            .eq('tenant_id', tenantId);

        if (search) {
            const safe = sanitizeSearch(search);
            if (safe.length > 0) {
                query = query.or(
                    `first_name.ilike.%${safe}%,last_name.ilike.%${safe}%,email.ilike.%${safe}%,title.ilike.%${safe}%`
                );
            }
        }
        if (filterCompanyIds.length > 0) query = query.in('company_id', filterCompanyIds);
        if (filterSeniorities.length > 0) query = query.in('seniority', filterSeniorities);
        if (filterCountries.length > 0) query = query.in('country', filterCountries);

        // nullsFirst: false ensures NULLs always go to end regardless of sort direction
        query = query
            .order(safeSortBy, { ascending: sortOrder, nullsFirst: false })
            .order('id', { ascending: true })
            .range(offset, offset + limit - 1);

        const { data, error, count } = await query;

        if (error) {
            log.error({ err: error }, 'List contacts error');
            res.status(500).json({ error: 'Failed to fetch contacts' });
            return;
        }

        const total = count || 0;
        const totalPages = Math.ceil(total / limit);

        res.json({
            data: data || [],
            pagination: {
                page,
                limit,
                total,
                totalPages,
                hasNext: page < totalPages,
                hasPrev: page > 1,
            },
        });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'List contacts error');
        res.status(500).json({ error: 'Failed to fetch contacts' });
    }
});

// GET /api/contacts/:id — Single contact + company info
router.get('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { id } = req.params;

        const { data, error } = await supabaseAdmin
            .from('contacts')
            .select(`*, companies(id, name, website, stage, location, industry)`)
            .eq('id', id)
            .eq('tenant_id', tenantId)
            .single();

        if (error || !data) {
            res.status(404).json({ error: 'Contact not found' });
            return;
        }

        res.json({ data });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Get contact error');
        res.status(500).json({ error: 'Failed to fetch contact' });
    }
});

// POST /api/contacts — Create contact
router.post(
    '/',
    requireRole('superadmin', 'ops_agent'),
    validateBody(createContactSchema),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const { company_id, first_name, last_name, title, email, phone_e164, linkedin, country, seniority, department, is_primary, notes } = req.body;

            const { data: company } = await supabaseAdmin
                .from('companies')
                .select('id')
                .eq('id', company_id)
                .eq('tenant_id', tenantId)
                .single();

            if (!company) {
                res.status(404).json({ error: 'Company not found' });
                return;
            }

            // Build payload
            const contactPayload: Record<string, unknown> = {
                tenant_id: tenantId,
                company_id,
                first_name,
                last_name: last_name || null,
                title: title || null,
                email: email || null,
                phone_e164: phone_e164 || null,
                linkedin: linkedin || null,
                country: country || null,
                seniority: seniority || null,
                department: department || null,
                is_primary: is_primary || false,
                notes: notes ? [{ id: randomUUID(), text: notes, created_at: new Date().toISOString(), created_by: req.user?.email || 'unknown' }] : [],
            };

            const { data, error } = await supabaseAdmin
                .from('contacts')
                .insert(contactPayload)
                .select()
                .single();

            if (error) {
                res.status(500).json({ error: 'Failed to create contact' });
                return;
            }

            res.status(201).json({ data });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Create contact error');
            res.status(500).json({ error: 'Failed to create contact' });
        }
    }
);

// PUT /api/contacts/:id — Update contact
router.put(
    '/:id',
    requireRole('superadmin', 'ops_agent'),
    validateBody(updateContactSchema),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const { id } = req.params;

            const { first_name, last_name, title, email, phone_e164, linkedin, country, seniority, department, is_primary } = req.body;

            const updateData: Record<string, unknown> = {};
            if (first_name !== undefined) updateData.first_name = first_name;
            if (last_name !== undefined) updateData.last_name = last_name;
            if (title !== undefined) updateData.title = title;
            if (email !== undefined) updateData.email = email;
            if (phone_e164 !== undefined) updateData.phone_e164 = phone_e164;
            if (linkedin !== undefined) updateData.linkedin = linkedin;
            if (country !== undefined) updateData.country = country;
            if (seniority !== undefined) updateData.seniority = seniority;
            if (department !== undefined) updateData.department = department;
            if (is_primary !== undefined) updateData.is_primary = is_primary;

            const { data, error } = await supabaseAdmin
                .from('contacts')
                .update(updateData)
                .eq('id', id)
                .eq('tenant_id', tenantId)
                .select()
                .single();

            if (error || !data) {
                res.status(404).json({ error: 'Contact not found' });
                return;
            }

            res.json({ data });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Update contact error');
            res.status(500).json({ error: 'Failed to update contact' });
        }
    }
);

// POST /api/contacts/:id/notes — Add a note to a contact
router.post(
    '/:id/notes',
    requireRole('superadmin', 'ops_agent'),
    validateBody(contactNoteSchema),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const { id } = req.params;
            const { text } = req.body;

            // Fetch current notes
            const { data: contact, error: fetchError } = await supabaseAdmin
                .from('contacts')
                .select('notes')
                .eq('id', id)
                .eq('tenant_id', tenantId)
                .single();

            if (fetchError || !contact) {
                res.status(404).json({ error: 'Contact not found' });
                return;
            }

            const existingNotes: ContactNote[] = parseNotes(contact.notes);

            const newNote: ContactNote = {
                id: randomUUID(),
                text: text.trim(),
                created_at: new Date().toISOString(),
                created_by: req.user?.email || 'unknown',
            };

            const updatedNotes = [newNote, ...existingNotes];

            const { data, error } = await supabaseAdmin
                .from('contacts')
                .update({ notes: updatedNotes })
                .eq('id', id)
                .eq('tenant_id', tenantId)
                .select()
                .single();

            if (error || !data) {
                res.status(500).json({ error: 'Failed to add note' });
                return;
            }

            res.status(201).json({ data });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Add note error');
            res.status(500).json({ error: 'Failed to add note' });
        }
    }
);

// DELETE /api/contacts/:id/notes/:noteId — Remove a note from a contact
router.delete(
    '/:id/notes/:noteId',
    requireRole('superadmin', 'ops_agent'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const { id, noteId } = req.params;

            const { data: contact, error: fetchError } = await supabaseAdmin
                .from('contacts')
                .select('notes')
                .eq('id', id)
                .eq('tenant_id', tenantId)
                .single();

            if (fetchError || !contact) {
                res.status(404).json({ error: 'Contact not found' });
                return;
            }

            const existingNotes: ContactNote[] = parseNotes(contact.notes);
            const updatedNotes = existingNotes.filter((n) => n.id !== noteId);

            if (updatedNotes.length === existingNotes.length) {
                res.status(404).json({ error: 'Note not found' });
                return;
            }

            const { data, error } = await supabaseAdmin
                .from('contacts')
                .update({ notes: updatedNotes })
                .eq('id', id)
                .eq('tenant_id', tenantId)
                .select()
                .single();

            if (error || !data) {
                res.status(500).json({ error: 'Failed to delete note' });
                return;
            }

            res.json({ data });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Delete note error');
            res.status(500).json({ error: 'Failed to delete note' });
        }
    }
);

// POST /api/contacts/:id/translate — Translate contact text fields + notes to Turkish
router.post(
    '/:id/translate',
    requireRole('superadmin', 'ops_agent'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const { id } = req.params;

            const { data: contact, error: fetchError } = await supabaseAdmin
                .from('contacts')
                .select('*')
                .eq('id', id)
                .eq('tenant_id', tenantId)
                .single();

            if (fetchError || !contact) {
                res.status(404).json({ error: 'Contact not found' });
                return;
            }

            // Collect translatable texts: title + each note
            const texts: Array<{ field: string; text: string }> = [];

            if (contact.title && contact.title.trim().length >= 2) {
                texts.push({ field: 'title', text: contact.title });
            }

            const notes: ContactNote[] = parseNotes(contact.notes);
            for (const note of notes) {
                if (note.text && note.text.trim().length >= 2) {
                    texts.push({ field: `note:${note.id}`, text: note.text });
                }
            }

            if (texts.length === 0) {
                res.status(400).json({ error: 'No translatable text fields found' });
                return;
            }

            const translated = await translateTexts(texts);

            if (Object.keys(translated).length === 0) {
                res.status(200).json({ data: contact, message: 'Already in Turkish or no translation needed' });
                return;
            }

            // Build translations object
            const translations: Record<string, unknown> = { translated_at: new Date().toISOString() };
            if (translated.title) translations.title = translated.title;

            const noteTranslations: Record<string, string> = {};
            for (const [key, value] of Object.entries(translated)) {
                if (key.startsWith('note:')) {
                    noteTranslations[key.slice(5)] = value;
                }
            }
            if (Object.keys(noteTranslations).length > 0) {
                translations.notes = noteTranslations;
            }

            const { data: updated, error: updateError } = await supabaseAdmin
                .from('contacts')
                .update({ translations })
                .eq('id', id)
                .eq('tenant_id', tenantId)
                .select()
                .single();

            if (updateError) {
                throw new AppError('Failed to save translations', 500);
            }

            res.json({ data: updated });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Translate contact error');
            res.status(500).json({ error: 'Translation failed' });
        }
    }
);

// DELETE /api/contacts/:id — Delete contact (superadmin only)
router.delete(
    '/:id',
    requireRole('superadmin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const { error } = await supabaseAdmin
                .from('contacts')
                .delete()
                .eq('id', req.params.id)
                .eq('tenant_id', req.tenantId!);

            if (error) {
                res.status(500).json({ error: 'Failed to delete contact' });
                return;
            }

            res.status(204).send();
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Delete contact error');
            res.status(500).json({ error: 'Failed to delete contact' });
        }
    }
);

export default router;
