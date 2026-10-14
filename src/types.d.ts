declare module "tz-lookup" {
  export default function tzlookup(lat: number, lon: number): string;
}

// Stylesheets imported for their side effects, bundled by Bun.
declare module "*.css";
