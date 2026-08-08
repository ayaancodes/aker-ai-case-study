-- Seed data for charge_codes lookup table.
-- 32 codes, verified by programmatic scan of every charge-line row across all 25 rent
-- roll files (see CLAUDE.md "What we already know" section). Categories confirmed against
-- actual amounts where it mattered (concession = CON*-prefixed codes, 214/216 negative,
-- see CLAUDE.md edge cases). Descriptions for the rest are best-effort based on standard
-- property management terminology, not from a data dictionary -- flagged low-confidence
-- ones below.

INSERT INTO charge_codes (code, description, category) VALUES
    ('RENT',     'Standard market rent',                                   'base_rent'),

    ('RENTAFF',  'Affordable / reduced-rate rent',                         'subsidy'),
    ('RENTHAP',  'Housing Assistance Payment portion of rent (Section 8)', 'subsidy'),
    ('SEC8CRD',  'Section 8 credit',                                       'subsidy'),
    ('SUBSIDY',  'General housing subsidy',                                'subsidy'),

    ('RENTRETL', 'Retail tenant rent',                                     'commercial'),
    ('RNTPROF',  'Professional / office tenant rent',                      'commercial'),
    ('CAMEST',   'Common area maintenance (CAM) estimate, pass-through',   'commercial'),
    ('CAMINSR',  'CAM insurance pass-through',                             'commercial'),
    ('RETXEST',  'Real estate tax estimate, pass-through',                 'commercial'),

    ('PARKING',  'Parking charge',                                         'ancillary'),
    ('GARAGE',   'Garage charge',                                          'ancillary'),
    ('STORAGE',  'Storage unit charge',                                    'ancillary'),
    ('AMENITY',  'Amenity fee',                                            'ancillary'),
    ('BIKE',     'Bike storage/parking charge',                            'ancillary'),
    ('W/D',      'Washer/dryer rental charge',                             'ancillary'),

    ('TRASH',    'Trash/waste removal charge',                             'utility'),
    ('WATER',    'Water charge',                                           'utility'),
    ('UTILCOM',  'Combined/common-area utility charge (low confidence)',   'utility'),

    ('PETFEE',   'One-time pet fee',                                       'fee'),
    ('PETFEEM',  'Monthly pet fee',                                        'fee'),
    ('SDFEE',    'Security-deposit-related fee (low confidence)',          'fee'),
    ('SALESTX',  'Sales tax on charges, pass-through',                     'fee'),
    ('MTM',      'Month-to-month lease premium',                          'fee'),
    ('HOMEPCKG', 'Home/amenity package fee (low confidence)',              'fee'),

    ('CONRENT',  'Rent concession/credit',                                 'concession'),
    ('CONPARK',  'Parking concession/credit',                              'concession'),
    ('CONGAR',   'Garage concession/credit',                               'concession'),
    ('CONPETM',  'Monthly pet fee concession/credit',                      'concession'),
    ('CONSTOR',  'Storage concession/credit',                              'concession'),
    ('CONAMEN',  'Amenity concession/credit',                              'concession'),
    ('CONEMP',   'Employee concession/credit',                             'concession');
