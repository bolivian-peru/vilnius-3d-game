// Starting points, as [label, longitude, latitude, street, at]. Each is snapped to the nearest street
// on arrival, preferring the named street when one is given. `at` pins an exact spawn instead:
// [east, north, heading] in local metres and radians (0 = east, counter-clockwise).
export const PLACES = [
  // Antakalnio g. approach, 60 m before the roundabout in front of the church.
  ['Antakalnis · Šv. Petro ir Povilo žiedas', 25.3043, 54.6934, 'Antakalnio g.', [1878.5, 481.5, -2.28]],
  // Other starts are switched off while this one area is being polished.
  /* ['Žaliasis tiltas', 25.2797, 54.6917],
  ['Antakalnis · Antakalnio g.', 25.3100, 54.7010, 'Antakalnio g.'],
  ['Antakalnis · šiaurinė dalis', 25.3260, 54.7140, 'Antakalnio g.'],
  ['Katedros aikštė', 25.2868, 54.6858],
  ['Gedimino pr. · Lukiškių aikštė', 25.2700, 54.6893, 'Gedimino pr.'],
  ['Rotušės aikštė', 25.2870, 54.6781],
  ['Užupis', 25.2955, 54.6805],
  ['Konstitucijos pr.', 25.2760, 54.6960, 'Konstitucijos pr.'],
  ['Žirmūnai', 25.2990, 54.7130],
  ['Stotis', 25.2850, 54.6705],
  ['TV bokštas · Karoliniškės', 25.2147, 54.6872],
  ['Oro uostas', 25.2870, 54.6370], */
];
