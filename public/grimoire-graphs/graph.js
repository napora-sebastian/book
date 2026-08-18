/* ===========================================================================
   The graphs page.

   Everything that makes the canvas work lives in constellation.js, which is a
   component rather than a page — the same module is mounted inside a modal
   over the deck on /grimoire-mix. This file is the whole difference between
   the two: here it owns the viewport, and #graph=3 in the address bar means
   something.
   =========================================================================== */

import { mountConstellation } from './constellation.js';

mountConstellation(document.getElementById('constellation'), { deepLink: true });
