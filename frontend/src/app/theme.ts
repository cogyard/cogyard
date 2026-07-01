import { definePreset } from '@primeuix/themes';
import Aura from '@primeuix/themes/aura';

// cogyard preset over Aura (task 021). Accent: the blue scale, resting on
// {blue.600} (#2563eb) — the exact accent the hand-rolled SCSS uses everywhere.
// Density: forms sit a step tighter than Aura's default to match the portal's
// compact 12–13px UI. Radii: Aura's md (6px) already matches the SCSS; untouched.
export const CogyardPreset = definePreset(Aura, {
  semantic: {
    primary: {
      50: '{blue.50}',
      100: '{blue.100}',
      200: '{blue.200}',
      300: '{blue.300}',
      400: '{blue.400}',
      500: '{blue.500}',
      600: '{blue.600}',
      700: '{blue.700}',
      800: '{blue.800}',
      900: '{blue.900}',
      950: '{blue.950}',
    },
    colorScheme: {
      light: {
        primary: {
          color: '{primary.600}',
          contrastColor: '#ffffff',
          hoverColor: '{primary.700}',
          activeColor: '{primary.800}',
        },
      },
    },
    formField: {
      paddingX: '0.625rem',
      paddingY: '0.375rem',
    },
  },
});
