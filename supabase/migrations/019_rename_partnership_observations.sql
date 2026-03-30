-- Rename partnership_observation columns to custom_field
ALTER TABLE companies
RENAME COLUMN partnership_observation_1 TO custom_field_1;

ALTER TABLE companies
RENAME COLUMN partnership_observation_2 TO custom_field_2;

ALTER TABLE companies
RENAME COLUMN partnership_observation_3 TO custom_field_3;
