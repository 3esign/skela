// Skela — sample field notes.
// Every name, number, address and price below is invented. The personal number and tax numbers
// are synthetic values that merely satisfy the checksum (the personal number encodes a birth
// date in the year 1900).

export const SAMPLES = [
  {
    id: 'block-b',
    title: 'Block B, level 3',
    hint: 'crack, scaffold, trench, prices',
    lexicon: 'Feniks',
    note: `Site visit 18 Nov, residential block B, level 3.
Investor: Dunav Gradnja d.o.o., PIB 102030400. Site address: Bulevar kralja Aleksandra 73a, Beograd.
Contractor: Mr. Jovan Petrović, phone 060/123-45-67, jovan.petrovic@example.com.
Slab S3 between axes C and D shows a diagonal crack 0.4 mm wide and 2.1 m long near the column head. Exposed rebar with corrosion at the soffit over about 30 cm.
North scaffold: guardrail missing along the working platform at 6 m height. Petrović says it will be fixed next week.
Trench for the sewer connection is 1.8 m deep with no shoring, and spoil is stored at the edge.
Repair offer from the subcontractor is 48,500 EUR; contract value 1.250.000 EUR. Handover of project Feniks is at risk.
Which code limits apply to the crack width, and is the slab safe to load?`,
  },
  {
    id: 'hall-2',
    title: 'Hall 2, morning walk',
    hint: 'two quick safety items',
    lexicon: '',
    note: `Morning walk, hall 2. Two workers without helmets at the rebar yard.
Fire extinguisher by the welding bay expired in September.
Reported by: Ms. Ana Kovač, ID card no. 0101900710004.`,
  },
  {
    id: 'objekat-c',
    title: 'Objekat C (Serbian)',
    hint: 'beleška na srpskom',
    lexicon: '',
    note: `Obilazak 18.11, objekat C. Investitor: Sava Invest d.o.o., MB 12345678.
Adresa: ul. Kneza Miloša 12, Beograd, k.p. 1432/5 K.O. Savski Venac.
Pukotina u gredi G2 širine 1,2 mm. Skela na južnoj fasadi nema ogradu na visini 8 m.
Nadzor: dipl. inž. Marko Ilić, tel. +381 11 222 3344. Cena sanacije 320.000 din.`,
  },
];

// The confidential values in each sample, used by the tests as the list that must never
// appear in anything that leaves the device.
export const SAMPLE_SECRETS = {
  'block-b': ['Dunav Gradnja', '102030400', 'Bulevar kralja Aleksandra', '73a', 'Jovan', 'Petrović', '060/123-45-67', 'jovan.petrovic@example.com', '48,500', '1.250.000', 'Feniks'],
  'hall-2': ['Ana', 'Kovač', '0101900710004'],
  'objekat-c': ['Sava Invest', '12345678', 'Kneza Miloša', '1432/5', 'Savski Venac', 'Marko', 'Ilić', '+381 11 222 3344', '320.000'],
};
