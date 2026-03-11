import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireRole } from '../middleware/auth.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('route:contacts');
const router = Router();

// GET /api/contacts?company_id=xxx — List contacts for a company
router.get('/', async (req: Request, res: Response): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const companyId = req.query.company_id as string;

        let query = supabaseAdmin
            .from('contacts')
            .select('*')
            .eq('tenant_id', tenantId)
            .order('is_primary', { ascending: false })
            .order('created_at', { ascending: true });

        if (companyId) {
            query = query.eq('company_id', companyId);
        }

        const { data, error } = await query;

        if (error) {
            res.status(500).json({ error: 'Failed to fetch contacts' });
            return;
        }

        res.json({ data: data || [] });
    } catch (err) {
        log.error({ err }, 'List contacts error');
        res.status(500).json({ error: 'Failed to fetch contacts' });
    }
});

// POST /api/contacts — Create contact
router.post(
    '/',
    requireRole('superadmin', 'ops_agent'),
    async (req: Request, res: Response): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const { company_id, first_name, last_name, title, email, phone_e164, linkedin, country, seniority, department, is_primary, notes } = req.body;

            if (!company_id || !first_name) {
                res.status(400).json({ error: 'company_id and first_name are required' });
                return;
            }

            // Verify company belongs to tenant
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

            const { data, error } = await supabaseAdmin
                .from('contacts')
                .insert({
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
                    notes: notes || null,
                })
                .select()
                .single();

            if (error) {
                res.status(500).json({ error: 'Failed to create contact' });
                return;
            }

            res.status(201).json({ data });
        } catch (err) {
            log.error({ err }, 'Create contact error');
            res.status(500).json({ error: 'Failed to create contact' });
        }
    }
);

// PUT /api/contacts/:id — Update contact
router.put(
    '/:id',
    requireRole('superadmin', 'ops_agent'),
    async (req: Request, res: Response): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const { id } = req.params;

            const { first_name, last_name, title, email, phone_e164, linkedin, country, seniority, department, is_primary, notes } = req.body;

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
            if (notes !== undefined) updateData.notes = notes;

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
            log.error({ err }, 'Update contact error');
            res.status(500).json({ error: 'Failed to update contact' });
        }
    }
);

// DELETE /api/contacts/:id — Delete contact (superadmin only)
router.delete(
    '/:id',
    requireRole('superadmin'),
    async (req: Request, res: Response): Promise<void> => {
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
            log.error({ err }, 'Delete contact error');
            res.status(500).json({ error: 'Failed to delete contact' });
        }
    }
);

export default router;
