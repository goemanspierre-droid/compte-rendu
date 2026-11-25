# Compte-rendu — application Android (prototype v2)

Enregistre une réunion, la transcrit, puis produit un résumé et la liste des actions à réaliser (qui, quoi, quand, priorité).

## Fonctionnement hybride wifi / hors wifi

| Situation | Transcription | Résumé + actions |
|---|---|---|
| **Wifi** | Cloud (Mistral Voxtral, ~0,003 $/min) | Envoyé tout de suite (Claude) |
| **Données mobiles** | Sur le téléphone (Whisper), **aucun audio envoyé** | Texte seul envoyé (quelques Ko), ou attente du wifi (réglable) |
| **Hors ligne** | Sur le téléphone | Mis en attente, envoyé automatiquement au retour du réseau |

Le modèle local se télécharge une seule fois, **en wifi** (bouton dans ⚙ Réglages). Tant qu'il n'est pas téléchargé, l'appli ne le télécharge jamais en 4G : l'enregistrement attend le wifi.

L'audio forme un seul fichier par réunion, sauvegardé toutes les 15 s : en cas de coupure, l'audio est récupéré jusqu'à la coupure.

## Reconnaissance des intervenants

- En wifi, la transcription cloud distingue les voix (Intervenant 1, 2…). Claude propose les noms qu'il déduit de la conversation (« merci Pierre… ») : ils sont marqués *nom suggéré, à vérifier*.
- Dans la carte **Intervenants**, chaque voix a son temps de parole, une phrase d'exemple et un bouton ▶ pour l'écouter. Le nom saisi est repris partout : résumé, responsables des actions, transcription, exports.
- Hors wifi, la transcription sur le téléphone ne distingue pas les voix. Au retour du wifi, l'audio est renvoyé au cloud et le résumé refait automatiquement (réglage désactivable ; ignoré si des actions ont déjà été cochées). Un bouton permet aussi de le faire à la demande.

## Export Outlook et agenda

- **✉ Outlook** : ouvre un nouveau message Outlook pré-rempli (objet, compte-rendu, destinataires par défaut). Le texte est aussi copié : si le message arrive vide ou tronqué, il suffit de le coller.
- **📅 par action** : chaque action a une date d'échéance (calculée par Claude à partir de « vendredi », « fin du mois »… et modifiable). Le bouton ouvre l'événement pré-rempli dans l'agenda Outlook (ou Google Agenda).
- **Toutes les échéances → .ics** : un seul fichier avec toutes les échéances ouvertes et la prochaine réunion, avec rappel. Sur PC, un double-clic l'importe dans Outlook.
- **Prochaine réunion** : si une date est évoquée, elle est proposée à l'ajout dans l'agenda.
- Réglages : compte Microsoft 365 (pro) ou Outlook.com (perso), choix de l'agenda.

## Installation (une fois, ~10 min)

L'appli doit être servie en HTTPS (obligatoire pour le micro). Le plus simple, gratuit :

1. Créer un compte sur **github.com**, puis un dépôt nouveau (ex. `compte-rendu`), en **Public**.
2. « Add file › Upload files » : glisser **tout le contenu** du dossier (index.html, app.js, sw.js, whisper-worker.js, manifest.webmanifest, dossiers `icons` et `vendor`). Valider (« Commit »).
3. Settings › Pages › Source : *Deploy from a branch*, branche `main`, dossier `/ (root)` › Save.
4. Après 1 à 2 min, l'adresse `https://<votre-compte>.github.io/compte-rendu/` est active.
5. Sur le téléphone Android, l'ouvrir dans **Chrome** › menu ⋮ › **Ajouter à l'écran d'accueil / Installer l'application**.

> Le code est public mais **pas vos données** : enregistrements, résumés et clés API restent uniquement dans le téléphone.

## Clés API (dans ⚙ Réglages)

- **Anthropic** (résumé) : console.anthropic.com › API Keys. Prévoir quelques euros de crédit.
- **Mistral** (transcription wifi) : console.mistral.ai › API Keys.
- Facultatif : OpenAI comme service de transcription de remplacement.

Ordre de grandeur : 1 h de réunion ≈ 0,20 € de transcription cloud + quelques centimes à ~0,15 € de résumé.

## Limites connues du prototype

- **Écran allumé** : l'enregistrement est fiable avec l'appli au premier plan (l'écran est maintenu allumé). Écran verrouillé, Android peut couper le micro. Solution de secours : enregistrer avec le dictaphone du téléphone puis « Importer un audio ».
- **Transcription locale** : plus lente que la durée de la réunion sur un téléphone moyen (modèle *Base*), et moins précise que le cloud. Utile surtout hors wifi.
- Les liens Outlook ouvrent Outlook sur le web (ou l'appli si Android la propose) : il faut être connecté à son compte Microsoft dans le navigateur.
- La reconnaissance des voix peut confondre deux personnes au timbre proche, ou une même personne près puis loin du micro : vérifiez la carte Intervenants.
- Si la transcription cloud échoue avec « Failed to fetch », basculer le service sur OpenAI dans les réglages.
