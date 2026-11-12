import type { CertInIncidentType } from '@chumbaq/shared';

/**
 * CERT-In Directions under section 70B(6) of the IT Act, 28 April 2022, Annexure I:
 * the types of cyber security incident that must be reported within 6 hours, verbatim
 * from the official PDF. A runtime copy (the API must not value-import
 * `@chumbaq/shared`), held to `CertInIncidentType` by the check below.
 */
export const ANNEXURE_I = [
  { id: 'i', label: 'Targeted scanning/probing of critical networks/systems' },
  { id: 'ii', label: 'Compromise of critical systems/information' },
  { id: 'iii', label: 'Unauthorised access of IT systems/data' },
  {
    id: 'iv',
    label:
      'Defacement of website or intrusion into a website and unauthorised changes such as inserting malicious code, links to external websites etc.',
  },
  {
    id: 'v',
    label: 'Malicious code attacks such as spreading of virus/worm/Trojan/Bots/Spyware/Ransomware/Cryptominers',
  },
  { id: 'vi', label: 'Attack on servers such as Database, Mail and DNS and network devices such as Routers' },
  { id: 'vii', label: 'Identity Theft, spoofing and phishing attacks' },
  { id: 'viii', label: 'Denial of Service (DoS) and Distributed Denial of Service (DDoS) attacks' },
  {
    id: 'ix',
    label: 'Attacks on Critical infrastructure, SCADA and operational technology systems and Wireless networks',
  },
  { id: 'x', label: 'Attacks on Application such as E-Governance, E-Commerce etc.' },
  { id: 'xi', label: 'Data Breach' },
  { id: 'xii', label: 'Data Leak' },
  {
    id: 'xiii',
    label: 'Attacks on Internet of Things (IoT) devices and associated systems, networks, software, servers',
  },
  { id: 'xiv', label: 'Attacks or incident affecting Digital Payment systems' },
  { id: 'xv', label: 'Attacks through Malicious mobile Apps' },
  { id: 'xvi', label: 'Fake mobile Apps' },
  { id: 'xvii', label: 'Unauthorised access to social media accounts' },
  {
    id: 'xviii',
    label: 'Attacks or malicious/ suspicious activities affecting Cloud computing systems/servers/software/applications',
  },
  {
    id: 'xix',
    label:
      'Attacks or malicious/suspicious activities affecting systems/ servers/ networks/ software/ applications related to Big Data, Block chain, virtual assets, virtual asset exchanges, custodian wallets, Robotics, 3D and 4D Printing, additive manufacturing, Drones',
  },
  {
    id: 'xx',
    label:
      'Attacks or malicious/ suspicious activities affecting systems/ servers/software/ applications related to Artificial Intelligence and Machine Learning',
  },
] as const satisfies readonly { id: CertInIncidentType; label: string }[];

export const ANNEXURE_I_IDS: readonly CertInIncidentType[] = ANNEXURE_I.map((t) => t.id);

export function isAnnexureId(value: unknown): value is CertInIncidentType {
  return typeof value === 'string' && (ANNEXURE_I_IDS as readonly string[]).includes(value);
}

export function annexureLabel(id: CertInIncidentType): string {
  return ANNEXURE_I.find((t) => t.id === id)!.label;
}

type SameSet<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const TYPES_MATCH_SHARED: SameSet<(typeof ANNEXURE_I)[number]['id'], CertInIncidentType> = true;
void TYPES_MATCH_SHARED;
