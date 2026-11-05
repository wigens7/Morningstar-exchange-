'use strict';

const COPY = {
  ht: {
    brand: 'Morningstar Exchange',
    footer: 'Mesaj otomatik sa a soti nan Morningstar Exchange.',
    otpTitle: {
      signup: 'Verifye adrès imèl ou',
      email_verification: 'Konfime adrès imèl ou',
      password_change: 'Konfime chanjman modpas la',
      password_reset: 'Reyinisyalize modpas ou'
    },
    otpIntro: {
      signup: 'Antre kòd sa a pou fini kreye kont ou.',
      email_verification: 'Antre kòd sa a pou verifye adrès imèl ki sou kont ou.',
      password_change: 'Antre kòd sa a pou konfime demann chanjman modpas ou a.',
      password_reset: 'Antre kòd sa a pou reyinisyalize modpas kont ou.'
    },
    expires: 'Kòd sa a ap ekspire nan 10 minit.',
    ignore: 'Si se pa ou ki te mande aksyon sa a, pa itilize kòd la epi chanje modpas ou si sa nesesè.',
    security: 'Pou sekirite ou, pa pataje kòd sa a ak pèsonn.',
    transaction: 'Aktivite kont ou',
    event: 'Yon aktivite enpòtan sou kont Morningstar Exchange ou.',
    admin: 'Nouvo aktivite enpòtan mande atansyon.',
    date: 'Dat ak lè'
  },
  en: {
    brand: 'Morningstar Exchange',
    footer: 'This automated message is from Morningstar Exchange.',
    otpTitle: {
      signup: 'Verify your email address',
      email_verification: 'Confirm your email address',
      password_change: 'Confirm your password change',
      password_reset: 'Reset your password'
    },
    otpIntro: {
      signup: 'Enter this code to finish creating your account.',
      email_verification: 'Enter this code to verify the email on your account.',
      password_change: 'Enter this code to confirm your password-change request.',
      password_reset: 'Enter this code to reset your account password.'
    },
    expires: 'This code expires in 10 minutes.',
    ignore: 'If you did not request this, do not use the code and change your password if needed.',
    security: 'For your security, do not share this code.',
    transaction: 'Account activity',
    event: 'Important activity on your Morningstar Exchange account.',
    admin: 'A new important activity needs attention.',
    date: 'Date and time'
  },
  fr: {
    brand: 'Morningstar Exchange',
    footer: 'Ce message automatique provient de Morningstar Exchange.',
    otpTitle: {
      signup: 'Vérifiez votre adresse e-mail',
      email_verification: 'Confirmez votre adresse e-mail',
      password_change: 'Confirmez le changement de mot de passe',
      password_reset: 'Réinitialisez votre mot de passe'
    },
    otpIntro: {
      signup: 'Saisissez ce code pour terminer la création de votre compte.',
      email_verification: 'Saisissez ce code pour vérifier l’adresse e-mail de votre compte.',
      password_change: 'Saisissez ce code pour confirmer votre demande de changement de mot de passe.',
      password_reset: 'Saisissez ce code pour réinitialiser le mot de passe de votre compte.'
    },
    expires: 'Ce code expire dans 10 minutes.',
    ignore: 'Si vous n’êtes pas à l’origine de cette demande, n’utilisez pas le code et changez votre mot de passe si nécessaire.',
    security: 'Pour votre sécurité, ne partagez pas ce code.',
    transaction: 'Activité du compte',
    event: 'Activité importante sur votre compte Morningstar Exchange.',
    admin: 'Une nouvelle activité importante nécessite votre attention.',
    date: 'Date et heure'
  },
  es: {
    brand: 'Morningstar Exchange',
    footer: 'Este mensaje automático es de Morningstar Exchange.',
    otpTitle: {
      signup: 'Verifica tu correo electrónico',
      email_verification: 'Confirma tu correo electrónico',
      password_change: 'Confirma el cambio de contraseña',
      password_reset: 'Restablece tu contraseña'
    },
    otpIntro: {
      signup: 'Introduce este código para terminar de crear tu cuenta.',
      email_verification: 'Introduce este código para verificar el correo de tu cuenta.',
      password_change: 'Introduce este código para confirmar tu solicitud de cambio de contraseña.',
      password_reset: 'Introduce este código para restablecer la contraseña de tu cuenta.'
    },
    expires: 'Este código vence en 10 minutos.',
    ignore: 'Si no solicitaste esto, no uses el código y cambia tu contraseña si es necesario.',
    security: 'Por tu seguridad, no compartas este código.',
    transaction: 'Actividad de la cuenta',
    event: 'Actividad importante en tu cuenta de Morningstar Exchange.',
    admin: 'Una actividad importante nueva requiere atención.',
    date: 'Fecha y hora'
  }
};

const NOTICES = {
  ht: {
    ACCOUNT_REGISTERED: { title: 'Nouvo kliyan verifye', USER: 'Imèl ou verifye. Kont Morningstar Exchange ou pare.', ADMIN: 'Yon nouvo kliyan verifye adrès imèl li.' },
    EMAIL_VERIFIED: { title: 'Adrès imèl verifye', USER: 'Adrès imèl kont ou verifye avèk siksè.' },
    PROFILE_UPDATED: { title: 'Enfòmasyon kont mete ajou', USER: 'Enfòmasyon pwofil kont ou an anrejistre. Nou pa mete detay pèsonèl ou nan imel sa a.' },
    PASSWORD_CHANGED: { title: 'Modpas chanje', USER: 'Modpas kont ou chanje avèk siksè. Si se pa ou ki te fè sa, kontakte sipò touswit.', ADMIN: 'Yon kliyan chanje modpas li avèk siksè.' },
    LOGIN_SECURITY: { title: 'Nouvo koneksyon sou kont ou', USER: 'Nou detekte yon nouvo koneksyon sou kont ou. Si se pa ou, chanje modpas ou epi kontakte sipò.' },
    DEPOSIT_REQUESTED: { title: 'Demann depo resevwa', USER: 'Nou resevwa deklarasyon depo ou. Sa pa konfime nou resevwa lajan an; ekip la dwe verifye li.', ADMIN: 'Yon kliyan soumèt yon demann depo ki poko verifye.' },
    DEPOSIT_APPROVED: { title: 'Depo trete', USER: 'Demann depo ou make kòm trete epi balans lan ajiste nan aplikasyon an.' },
    DEPOSIT_REJECTED: { title: 'Demann depo refize', USER: 'Demann depo ou refize. Tcheke estati a nan kont ou oswa kontakte sipò.' },
    WITHDRAWAL_REQUESTED: { title: 'Demann retrè resevwa', USER: 'Nou resevwa demann retrè ou; li poko vle di peman an fèt.', ADMIN: 'Yon nouvo demann retrè ap tann tretman.' },
    WITHDRAWAL_PAID: { title: 'Retrè make kòm peye', USER: 'Administratè a make retrè ou kòm peye. Imèl sa a pa yon verifikasyon endepandan resepsyon lajan an.' },
    WITHDRAWAL_REJECTED: { title: 'Demann retrè refize', USER: 'Demann retrè ou refize; aplikasyon an retounen kantite a nan balans kont ou.' },
    KYC_APPROVED: { title: 'Verifikasyon idantite apwouve', USER: 'Ekip la apwouve verifikasyon idantite kont ou.' },
    CARDHOLDER_APPROVED: { title: 'Dosye kat ou pare', USER: 'Cardholder ZiiroPay ou apwouve epi li asosye ak kont Morningstar Exchange ou. Dosye ou pare pou etap kreasyon kat la. Kat la poko kreye; acha kat poko aktive.' },
    KYC_REJECTED: { title: 'Verifikasyon idantite pa apwouve', USER: 'Ekip la pa apwouve verifikasyon an. Gade estati a nan kont ou pou pwochen etap yo.' },
    KYC_REUPLOAD: { title: 'Nou bezwen nouvo dokiman', USER: 'Ekip la mande pou ou voye dokiman verifikasyon yo ankò.' },
    P2P_ORDER_CREATED: { title: 'Nouvo lòd P2P', BUYER: 'Ou kreye yon lòd P2P. Swiv enstriksyon lòd la; pa gen peman ki konfime nan imel sa a.', SELLER: 'Yon achtè kreye yon nouvo lòd. Poko gen peman konfime; tann deklarasyon achtè a epi verifye lajan an anvan ou lage crypto a.', ADMIN: 'Yon nouvo lòd P2P kreye; sa pa konfime peman.' },
    P2P_PAYMENT_REPORTED: { title: 'Achtè a deklare li peye', SELLER: 'Achtè a deklare li voye peman an. Sa se deklarasyon achtè a sèlman; verifye lajan an antre vre anvan ou lage crypto a.', ADMIN: 'Achtè a deklare peman an voye. Pa gen konfimasyon pwovizè ni lage crypto ki enplike.' },
    P2P_PAYMENT_VERIFIED: { title: 'Peman verifye pa pwovizè', USER: 'Pwovizè peman an verifye peman an pou lòd sa a. Lòd la poko fini jiskaske crypto a lage.', ADMIN: 'Pwovizè peman an verifye peman an; escrow toujou pa lage.' },
    P2P_RELEASED: { title: 'Lòd P2P fini', USER: 'Vandè a lage crypto a. Lòd P2P sa a fini.', ADMIN: 'Vandè a lage crypto a epi lòd la fini.' },
    P2P_ADMIN_RELEASED: { title: 'Lòd P2P fini', USER: 'Administratè a apwouve liberasyon crypto a; lòd la fini.', ADMIN: 'Administratè a apwouve liberasyon escrow la.' },
    P2P_ADMIN_RETURNED: { title: 'Escrow P2P retounen', USER: 'Administratè a retounen escrow la bay vandè a. Gade estati lòd la nan aplikasyon an.', ADMIN: 'Administratè a retounen escrow bay vandè a.' },
    P2P_DISPUTE_RESOLVED: { title: 'Dispit P2P rezoud', USER: 'Ekip la rezoud dispit la. Gade desizyon an ak estati lòd la nan aplikasyon an.', ADMIN: 'Ekip la rezoud dispit P2P la; desizyon an make anba a.' },
    P2P_CANCELLED: { title: 'Lòd P2P anile', USER: 'Lòd P2P la anile. Si gen yon rezon estanda ki disponib, li make anba a.', ADMIN: 'Yon lòd P2P anile.' },
    P2P_EXPIRED: { title: 'Lòd P2P ekspire', USER: 'Lòd P2P la ekspire san konfimasyon peman; crypto nan escrow la retounen bay vandè a.', ADMIN: 'Yon lòd P2P ekspire san konfimasyon peman.' },
    P2P_DISPUTE_OPENED: { title: 'Nouvo dispit P2P', USER: 'Yon dispit louvri pou lòd sa a. Escrow la rete bloke pandan revizyon an.', ADMIN: 'Yon nouvo dispit P2P louvri epi mande revizyon.' },
    P2P_DISPUTE_TAKEN: { title: 'Dispit la anba revizyon', USER: 'Ekip sipò a kòmanse revize dispit la. Escrow la rete bloke jiskaske desizyon an.', ADMIN: 'Yon manm ekip la pran dispit la pou revizyon.' },
    P2P_NEW_OFFER: { title: 'Nouvo òf P2P', USER: 'Òf P2P ou kreye a pibliye.', ADMIN: 'Yon nouvo òf P2P pibliye.' },
    P2P_AD_STATUS: { title: 'Estati òf P2P chanje', USER: 'Estati òf P2P ou a chanje. Tcheke òf la nan aplikasyon an.' },
    P2P_STATUS: { title: 'Mizajou sou lòd P2P', USER: 'Nou mete estati lòd P2P ou ajou.' },
    P2P_ADMIN_ALERT: { title: 'Alèt aktivite P2P', ADMIN: 'Sistèm nan detekte yon aktivite oswa yon pwoblèm P2P ki mande atansyon.' },
    SYSTEM_OPERATION_ERROR: { title: 'Erè operasyon enpòtan', ADMIN: 'Yon demann pou yon operasyon enpòtan retounen erè. Verifye estati li nan aplikasyon an anvan ou fè lòt aksyon.' }
  },
  en: {
    ACCOUNT_REGISTERED: { title: 'New verified customer', USER: 'Your email is verified. Your Morningstar Exchange account is ready.', ADMIN: 'A new customer verified their email address.' },
    EMAIL_VERIFIED: { title: 'Email address verified', USER: 'The email address on your account was verified successfully.' },
    PROFILE_UPDATED: { title: 'Account information updated', USER: 'Your account profile information was saved. This email does not include personal details.' },
    PASSWORD_CHANGED: { title: 'Password changed', USER: 'Your account password was changed successfully. If this was not you, contact support immediately.', ADMIN: 'A customer successfully changed their password.' },
    LOGIN_SECURITY: { title: 'New sign-in to your account', USER: 'We detected a new sign-in to your account. If this was not you, change your password and contact support.' },
    DEPOSIT_REQUESTED: { title: 'Deposit request received', USER: 'We received your deposit report. This does not confirm receipt of funds; the team must verify it.', ADMIN: 'A customer submitted a deposit request that is not yet verified.' },
    DEPOSIT_APPROVED: { title: 'Deposit processed', USER: 'Your deposit request was marked processed and the app balance was adjusted.' },
    DEPOSIT_REJECTED: { title: 'Deposit request declined', USER: 'Your deposit request was declined. Check your account status or contact support.' },
    WITHDRAWAL_REQUESTED: { title: 'Withdrawal request received', USER: 'We received your withdrawal request; this does not mean payment has been sent.', ADMIN: 'A new withdrawal request is awaiting processing.' },
    WITHDRAWAL_PAID: { title: 'Withdrawal marked paid', USER: 'An administrator marked your withdrawal as paid. This email is not independent proof that funds were received.' },
    WITHDRAWAL_REJECTED: { title: 'Withdrawal request declined', USER: 'Your withdrawal request was declined; the app returned the amount to your account balance.' },
    KYC_APPROVED: { title: 'Identity verification approved', USER: 'The team approved your account identity verification.' },
    KYC_REJECTED: { title: 'Identity verification not approved', USER: 'The team did not approve your verification. Check your account for next steps.' },
    KYC_REUPLOAD: { title: 'New documents requested', USER: 'The team asked you to submit your verification documents again.' },
    P2P_ORDER_CREATED: { title: 'New P2P order', BUYER: 'You created a P2P order. Follow the order instructions; this email does not confirm payment.', SELLER: 'A buyer created a new order. No payment is confirmed; verify funds before releasing crypto.', ADMIN: 'A new P2P order was created; this does not confirm payment.' },
    P2P_PAYMENT_REPORTED: { title: 'Buyer reported payment', SELLER: 'The buyer says they sent payment. This is only the buyer’s statement; verify that funds actually arrived before releasing crypto.', ADMIN: 'The buyer reported payment. No provider confirmation or crypto release is implied.' },
    P2P_PAYMENT_VERIFIED: { title: 'Payment verified by provider', USER: 'The payment provider verified payment for this order. The order is not complete until crypto is released.', ADMIN: 'The payment provider verified payment; escrow has not been released.' },
    P2P_RELEASED: { title: 'P2P order completed', USER: 'The seller released the crypto. This P2P order is complete.', ADMIN: 'The seller released crypto and the order completed.' },
    P2P_ADMIN_RELEASED: { title: 'P2P order complete', USER: 'An administrator approved release of the crypto; the order is complete.', ADMIN: 'An administrator approved release of escrow.' },
    P2P_ADMIN_RETURNED: { title: 'P2P escrow returned', USER: 'An administrator returned escrow to the seller. Check the order status in the app.', ADMIN: 'An administrator returned escrow to the seller.' },
    P2P_DISPUTE_RESOLVED: { title: 'P2P dispute resolved', USER: 'The team resolved the dispute. Check the decision and order status in the app.', ADMIN: 'The team resolved the P2P dispute; the decision is listed below.' },
    P2P_CANCELLED: { title: 'P2P order cancelled', USER: 'The P2P order was cancelled. A standard reason, when available, appears below.', ADMIN: 'A P2P order was cancelled.' },
    P2P_EXPIRED: { title: 'P2P order expired', USER: 'The P2P order expired without confirmed payment; escrow crypto was returned to the seller.', ADMIN: 'A P2P order expired without confirmed payment.' },
    P2P_DISPUTE_OPENED: { title: 'New P2P dispute', USER: 'A dispute was opened for this order. Escrow remains locked during review.', ADMIN: 'A new P2P dispute was opened and needs review.' },
    P2P_DISPUTE_TAKEN: { title: 'Dispute under review', USER: 'Support has started reviewing the dispute. Escrow remains locked until a decision.', ADMIN: 'A team member took the dispute for review.' },
    P2P_NEW_OFFER: { title: 'New P2P offer', USER: 'Your P2P offer was created and published.', ADMIN: 'A new P2P offer was published.' },
    P2P_AD_STATUS: { title: 'P2P offer status changed', USER: 'Your P2P offer status changed. Check the offer in the app.' },
    P2P_STATUS: { title: 'P2P order update', USER: 'The status of your P2P order was updated.' },
    P2P_ADMIN_ALERT: { title: 'P2P activity alert', ADMIN: 'The system detected P2P activity or an issue that needs attention.' },
    SYSTEM_OPERATION_ERROR: { title: 'Important operation error', ADMIN: 'A request for an important operation returned an error. Check its status in the app before taking further action.' }
  },
  fr: {
    ACCOUNT_REGISTERED: { title: 'Nouveau client vérifié', USER: 'Votre e-mail est vérifié. Votre compte Morningstar Exchange est prêt.', ADMIN: 'Un nouveau client a vérifié son adresse e-mail.' },
    EMAIL_VERIFIED: { title: 'Adresse e-mail vérifiée', USER: 'L’adresse e-mail de votre compte a été vérifiée.' },
    PROFILE_UPDATED: { title: 'Informations du compte mises à jour', USER: 'Les informations de votre profil ont été enregistrées. Cet e-mail ne contient pas de données personnelles.' },
    PASSWORD_CHANGED: { title: 'Mot de passe modifié', USER: 'Le mot de passe de votre compte a été modifié. Si vous n’êtes pas à l’origine de cette action, contactez immédiatement le support.', ADMIN: 'Un client a modifié son mot de passe.' },
    LOGIN_SECURITY: { title: 'Nouvelle connexion à votre compte', USER: 'Une nouvelle connexion à votre compte a été détectée. Si ce n’était pas vous, changez votre mot de passe et contactez le support.' },
    DEPOSIT_REQUESTED: { title: 'Demande de dépôt reçue', USER: 'Nous avons reçu votre déclaration de dépôt. Cela ne confirme pas la réception des fonds; l’équipe doit les vérifier.', ADMIN: 'Un client a soumis une demande de dépôt qui n’est pas encore vérifiée.' },
    DEPOSIT_APPROVED: { title: 'Dépôt traité', USER: 'Votre demande de dépôt a été marquée comme traitée et le solde de l’application a été ajusté.' },
    DEPOSIT_REJECTED: { title: 'Demande de dépôt refusée', USER: 'Votre demande de dépôt a été refusée. Consultez votre compte ou contactez le support.' },
    WITHDRAWAL_REQUESTED: { title: 'Demande de retrait reçue', USER: 'Nous avons reçu votre demande de retrait; cela ne signifie pas que le paiement a été envoyé.', ADMIN: 'Une nouvelle demande de retrait attend son traitement.' },
    WITHDRAWAL_PAID: { title: 'Retrait marqué comme payé', USER: 'Un administrateur a marqué votre retrait comme payé. Cet e-mail ne prouve pas indépendamment la réception des fonds.' },
    WITHDRAWAL_REJECTED: { title: 'Demande de retrait refusée', USER: 'Votre demande de retrait a été refusée; le montant a été rendu au solde de votre compte dans l’application.' },
    KYC_APPROVED: { title: 'Vérification d’identité approuvée', USER: 'L’équipe a approuvé la vérification d’identité de votre compte.' },
    KYC_REJECTED: { title: 'Vérification d’identité non approuvée', USER: 'L’équipe n’a pas approuvé votre vérification. Consultez votre compte pour connaître les prochaines étapes.' },
    KYC_REUPLOAD: { title: 'Nouveaux documents demandés', USER: 'L’équipe vous demande de soumettre à nouveau vos documents de vérification.' },
    P2P_ORDER_CREATED: { title: 'Nouvel ordre P2P', BUYER: 'Vous avez créé un ordre P2P. Suivez ses instructions; cet e-mail ne confirme pas un paiement.', SELLER: 'Un acheteur a créé un nouvel ordre. Aucun paiement n’est confirmé; vérifiez les fonds avant de libérer les crypto-actifs.', ADMIN: 'Un nouvel ordre P2P a été créé; cela ne confirme pas un paiement.' },
    P2P_PAYMENT_REPORTED: { title: 'Paiement déclaré par l’acheteur', SELLER: 'L’acheteur déclare avoir envoyé le paiement. C’est sa déclaration uniquement; vérifiez la réception réelle des fonds avant de libérer les crypto-actifs.', ADMIN: 'L’acheteur a déclaré le paiement envoyé. Aucune confirmation du prestataire ni libération n’est implicite.' },
    P2P_PAYMENT_VERIFIED: { title: 'Paiement vérifié par le prestataire', USER: 'Le prestataire a vérifié le paiement de cet ordre. L’ordre n’est terminé que lorsque les crypto-actifs sont libérés.', ADMIN: 'Le prestataire a vérifié le paiement; l’escrow n’a pas été libéré.' },
    P2P_RELEASED: { title: 'Ordre P2P terminé', USER: 'Le vendeur a libéré les crypto-actifs. Cet ordre P2P est terminé.', ADMIN: 'Le vendeur a libéré les crypto-actifs et l’ordre est terminé.' },
    P2P_ADMIN_RELEASED: { title: 'Ordre P2P terminé', USER: 'Un administrateur a approuvé la libération de la crypto; l’ordre est terminé.', ADMIN: 'Un administrateur a approuvé la libération de l’escrow.' },
    P2P_ADMIN_RETURNED: { title: 'Escrow P2P retourné', USER: 'Un administrateur a retourné l’escrow au vendeur. Consultez le statut de l’ordre dans l’application.', ADMIN: 'Un administrateur a retourné l’escrow au vendeur.' },
    P2P_DISPUTE_RESOLVED: { title: 'Litige P2P résolu', USER: 'L’équipe a résolu le litige. Consultez la décision et le statut de l’ordre dans l’application.', ADMIN: 'L’équipe a résolu le litige P2P; la décision est indiquée ci-dessous.' },
    P2P_CANCELLED: { title: 'Ordre P2P annulé', USER: 'L’ordre P2P a été annulé. Un motif standard, s’il est disponible, apparaît ci-dessous.', ADMIN: 'Un ordre P2P a été annulé.' },
    P2P_EXPIRED: { title: 'Ordre P2P expiré', USER: 'L’ordre P2P a expiré sans paiement confirmé; les crypto-actifs escrow ont été rendus au vendeur.', ADMIN: 'Un ordre P2P a expiré sans paiement confirmé.' },
    P2P_DISPUTE_OPENED: { title: 'Nouveau litige P2P', USER: 'Un litige a été ouvert pour cet ordre. L’escrow reste bloqué pendant l’examen.', ADMIN: 'Un nouveau litige P2P nécessite un examen.' },
    P2P_DISPUTE_TAKEN: { title: 'Litige en cours d’examen', USER: 'Le support a commencé l’examen du litige. L’escrow reste bloqué jusqu’à la décision.', ADMIN: 'Un membre de l’équipe a pris le litige en charge.' },
    P2P_NEW_OFFER: { title: 'Nouvelle offre P2P', USER: 'Votre offre P2P a été créée et publiée.', ADMIN: 'Une nouvelle offre P2P a été publiée.' },
    P2P_AD_STATUS: { title: 'Statut de l’offre P2P modifié', USER: 'Le statut de votre offre P2P a changé. Consultez-la dans l’application.' },
    P2P_STATUS: { title: 'Mise à jour de l’ordre P2P', USER: 'Le statut de votre ordre P2P a été mis à jour.' },
    P2P_ADMIN_ALERT: { title: 'Alerte d’activité P2P', ADMIN: 'Le système a détecté une activité ou un problème P2P nécessitant votre attention.' },
    SYSTEM_OPERATION_ERROR: { title: 'Erreur d’opération importante', ADMIN: 'Une demande d’opération importante a renvoyé une erreur. Vérifiez son statut dans l’application avant toute autre action.' }
  },
  es: {
    ACCOUNT_REGISTERED: { title: 'Nuevo cliente verificado', USER: 'Tu correo está verificado. Tu cuenta de Morningstar Exchange está lista.', ADMIN: 'Un nuevo cliente verificó su correo electrónico.' },
    EMAIL_VERIFIED: { title: 'Correo electrónico verificado', USER: 'El correo electrónico de tu cuenta se verificó correctamente.' },
    PROFILE_UPDATED: { title: 'Información de cuenta actualizada', USER: 'Guardamos la información de tu perfil. Este correo no incluye datos personales.' },
    PASSWORD_CHANGED: { title: 'Contraseña cambiada', USER: 'La contraseña de tu cuenta se cambió correctamente. Si no fuiste tú, contacta al soporte de inmediato.', ADMIN: 'Un cliente cambió su contraseña correctamente.' },
    LOGIN_SECURITY: { title: 'Nuevo inicio de sesión', USER: 'Detectamos un nuevo inicio de sesión en tu cuenta. Si no fuiste tú, cambia tu contraseña y contacta al soporte.' },
    DEPOSIT_REQUESTED: { title: 'Solicitud de depósito recibida', USER: 'Recibimos tu reporte de depósito. Esto no confirma la recepción de fondos; el equipo debe verificarlo.', ADMIN: 'Un cliente envió una solicitud de depósito aún no verificada.' },
    DEPOSIT_APPROVED: { title: 'Depósito procesado', USER: 'La solicitud de depósito se marcó como procesada y el saldo de la aplicación se actualizó.' },
    DEPOSIT_REJECTED: { title: 'Solicitud de depósito rechazada', USER: 'Tu solicitud de depósito fue rechazada. Revisa el estado en tu cuenta o contacta al soporte.' },
    WITHDRAWAL_REQUESTED: { title: 'Solicitud de retiro recibida', USER: 'Recibimos tu solicitud de retiro; esto no significa que el pago se haya enviado.', ADMIN: 'Una nueva solicitud de retiro está pendiente de procesamiento.' },
    WITHDRAWAL_PAID: { title: 'Retiro marcado como pagado', USER: 'Un administrador marcó tu retiro como pagado. Este correo no verifica de forma independiente la recepción de fondos.' },
    WITHDRAWAL_REJECTED: { title: 'Solicitud de retiro rechazada', USER: 'Tu solicitud de retiro fue rechazada; la aplicación devolvió el importe al saldo de tu cuenta.' },
    KYC_APPROVED: { title: 'Verificación de identidad aprobada', USER: 'El equipo aprobó la verificación de identidad de tu cuenta.' },
    KYC_REJECTED: { title: 'Verificación de identidad no aprobada', USER: 'El equipo no aprobó tu verificación. Revisa tu cuenta para conocer los siguientes pasos.' },
    KYC_REUPLOAD: { title: 'Se necesitan nuevos documentos', USER: 'El equipo pidió que vuelvas a enviar tus documentos de verificación.' },
    P2P_ORDER_CREATED: { title: 'Nueva orden P2P', BUYER: 'Creaste una orden P2P. Sigue sus instrucciones; este correo no confirma el pago.', SELLER: 'Un comprador creó una orden. No hay pago confirmado; verifica que recibiste los fondos antes de liberar cripto.', ADMIN: 'Se creó una nueva orden P2P; esto no confirma el pago.' },
    P2P_PAYMENT_REPORTED: { title: 'El comprador reportó el pago', SELLER: 'El comprador afirma que envió el pago. Es solo una declaración; verifica que los fondos llegaron antes de liberar cripto.', ADMIN: 'El comprador reportó el pago. No implica confirmación del proveedor ni liberación de cripto.' },
    P2P_PAYMENT_VERIFIED: { title: 'Pago verificado por el proveedor', USER: 'El proveedor verificó el pago de esta orden. La orden no termina hasta que se libere la cripto.', ADMIN: 'El proveedor verificó el pago; el escrow no se ha liberado.' },
    P2P_RELEASED: { title: 'Orden P2P completada', USER: 'El vendedor liberó la cripto. Esta orden P2P está completa.', ADMIN: 'El vendedor liberó la cripto y la orden se completó.' },
    P2P_ADMIN_RELEASED: { title: 'Orden P2P completada', USER: 'Un administrador aprobó la liberación de la cripto; la orden está completa.', ADMIN: 'Un administrador aprobó la liberación del escrow.' },
    P2P_ADMIN_RETURNED: { title: 'Escrow P2P devuelto', USER: 'Un administrador devolvió el escrow al vendedor. Consulta el estado de la orden en la aplicación.', ADMIN: 'Un administrador devolvió el escrow al vendedor.' },
    P2P_DISPUTE_RESOLVED: { title: 'Disputa P2P resuelta', USER: 'El equipo resolvió la disputa. Consulta la decisión y el estado de la orden en la aplicación.', ADMIN: 'El equipo resolvió la disputa P2P; la decisión aparece abajo.' },
    P2P_CANCELLED: { title: 'Orden P2P cancelada', USER: 'La orden P2P fue cancelada. Si hay un motivo estándar disponible, aparece abajo.', ADMIN: 'Se canceló una orden P2P.' },
    P2P_EXPIRED: { title: 'Orden P2P vencida', USER: 'La orden P2P venció sin pago confirmado; el escrow de cripto volvió al vendedor.', ADMIN: 'Una orden P2P venció sin pago confirmado.' },
    P2P_DISPUTE_OPENED: { title: 'Nueva disputa P2P', USER: 'Se abrió una disputa para esta orden. El escrow sigue bloqueado durante la revisión.', ADMIN: 'Se abrió una nueva disputa P2P que requiere revisión.' },
    P2P_DISPUTE_TAKEN: { title: 'Disputa en revisión', USER: 'El equipo de soporte comenzó a revisar la disputa. El escrow sigue bloqueado hasta la decisión.', ADMIN: 'Un miembro del equipo tomó la disputa para revisarla.' },
    P2P_NEW_OFFER: { title: 'Nueva oferta P2P', USER: 'Tu oferta P2P fue creada y publicada.', ADMIN: 'Se publicó una nueva oferta P2P.' },
    P2P_AD_STATUS: { title: 'Cambió el estado de la oferta P2P', USER: 'Cambió el estado de tu oferta P2P. Revísala en la aplicación.' },
    P2P_STATUS: { title: 'Actualización de orden P2P', USER: 'Se actualizó el estado de tu orden P2P.' },
    P2P_ADMIN_ALERT: { title: 'Alerta de actividad P2P', ADMIN: 'El sistema detectó actividad o un problema P2P que requiere atención.' },
    SYSTEM_OPERATION_ERROR: { title: 'Error de operación importante', ADMIN: 'Una solicitud de operación importante devolvió un error. Comprueba su estado en la aplicación antes de actuar.' }
  }
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function language() {
  return 'ht';
}

function shell({ locale = 'ht', title, preheader, content }) {
  const copy = COPY[language(locale)];
  return `<!doctype html><html lang="${language(locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><title>${escapeHtml(title)}</title><style>@media(max-width:600px){.card{padding:24px!important}.code{font-size:30px!important;letter-spacing:6px!important}}</style></head><body style="margin:0;background:#090a0f;color:#e5e7eb;font-family:Arial,Helvetica,sans-serif"><div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader || '')}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#090a0f;padding:28px 12px"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;background:#12141d;border:1px solid #2a2d38;border-radius:18px"><tr><td class="card" style="padding:34px"><p style="margin:0 0 26px;color:#f1c40f;font-size:18px;font-weight:800;letter-spacing:.04em">${copy.brand}</p><h1 style="margin:0 0 16px;color:#fff;font-size:24px;line-height:1.3">${escapeHtml(title)}</h1>${content}<hr style="border:0;border-top:1px solid #2a2d38;margin:28px 0 16px"><p style="margin:0;color:#8f96a3;font-size:12px;line-height:1.6">${copy.footer}</p></td></tr></table></td></tr></table></body></html>`;
}

function otpEmail({ code, purpose, locale = 'ht' }) {
  const lang = language(locale);
  const copy = COPY[lang];
  const title = copy.otpTitle[purpose] || copy.otpTitle.email_verification;
  const intro = copy.otpIntro[purpose] || copy.otpIntro.email_verification;
  const html = shell({
    locale: lang,
    title,
    preheader: intro,
    content: `<p style="margin:0 0 22px;color:#c5c9d2;font-size:15px;line-height:1.65">${escapeHtml(intro)}</p><div class="code" style="margin:0 0 22px;padding:18px 14px;border:1px solid #594b20;border-radius:12px;background:#19170f;color:#f1c40f;text-align:center;font-family:monospace;font-size:34px;font-weight:700;letter-spacing:10px">${escapeHtml(code)}</div><p style="margin:0 0 12px;color:#c5c9d2;font-size:14px;line-height:1.6">${escapeHtml(copy.expires)}</p><p style="margin:0 0 12px;color:#c5c9d2;font-size:14px;line-height:1.6">${escapeHtml(copy.security)}</p><p style="margin:0;color:#8f96a3;font-size:13px;line-height:1.6">${escapeHtml(copy.ignore)}</p>`
  });
  const text = `${title}\n\n${intro}\n\n${code}\n\n${copy.expires}\n${copy.security}\n${copy.ignore}\n\n${copy.brand}`;
  return { subject: title, html, text };
}

function noticeEmail({ title, summary, details = [], locale = 'ht', admin = false, occurredAt = new Date().toISOString() }) {
  const lang = language(locale);
  const copy = COPY[lang];
  const intro = admin ? copy.admin : copy.event;
  const safeDetails = Array.isArray(details)
    ? details.filter((item) => item && item.label && item.value != null)
    : [];
  const rows = safeDetails.map((item) =>
    `<tr><td style="padding:8px 0;color:#8f96a3;font-size:13px;vertical-align:top">${escapeHtml(item.label)}</td><td style="padding:8px 0;color:#e5e7eb;font-size:13px;text-align:right;vertical-align:top">${escapeHtml(item.value)}</td></tr>`
  ).join('');
  const html = shell({
    locale: lang,
    title,
    preheader: summary,
    content: `<p style="margin:0 0 18px;color:#c5c9d2;font-size:15px;line-height:1.65">${escapeHtml(summary || intro)}</p>${rows ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-top:1px solid #2a2d38">${rows}<tr><td style="padding:8px 0;color:#8f96a3;font-size:13px">${escapeHtml(copy.date)}</td><td style="padding:8px 0;color:#e5e7eb;font-size:13px;text-align:right">${escapeHtml(occurredAt)}</td></tr></table>` : `<p style="margin:0;color:#8f96a3;font-size:13px">${escapeHtml(copy.date)}: ${escapeHtml(occurredAt)}</p>`}`
  });
  const plainDetails = safeDetails.map((item) => `${item.label}: ${item.value}`).join('\n');
  return {
    subject: title,
    html,
    text: `${title}\n\n${summary || intro}\n${plainDetails ? `\n${plainDetails}` : ''}\n\n${copy.date}: ${occurredAt}\n${copy.brand}`
  };
}

function notificationEmail({ eventType, audience = 'USER', locale = 'ht', payload = {} }) {
  const lang = language(locale);
  const entry = (NOTICES[lang] && NOTICES[lang][eventType]) || NOTICES.ht[eventType];
  if (!entry) return null;
  const role = String(audience).toUpperCase() === 'ADMIN' ? 'ADMIN' : String(audience).toUpperCase();
  const summary = entry[role] || entry.USER || entry.ADMIN;
  const labels = {
    ht: { order: 'Lòd', offer: 'Òf', request: 'Demann', amount: 'Montan', method: 'Metòd', status: 'Estati', reason: 'Rezon', alert: 'Alèt', event: 'Evènman' },
    en: { order: 'Order', offer: 'Offer', request: 'Request', amount: 'Amount', method: 'Method', status: 'Status', reason: 'Reason', alert: 'Alert', event: 'Event' },
    fr: { order: 'Ordre', offer: 'Offre', request: 'Demande', amount: 'Montant', method: 'Méthode', status: 'Statut', reason: 'Motif', alert: 'Alerte', event: 'Événement' },
    es: { order: 'Orden', offer: 'Oferta', request: 'Solicitud', amount: 'Importe', method: 'Método', status: 'Estado', reason: 'Motivo', alert: 'Alerta', event: 'Evento' }
  }[lang];
  const details = [];
  if (payload.orderRef) details.push({ label: labels.order, value: payload.orderRef });
  if (payload.adRef) details.push({ label: labels.offer, value: payload.adRef });
  if (payload.txRef) details.push({ label: labels.request, value: payload.txRef });
  if (payload.amount) details.push({ label: labels.amount, value: payload.amount });
  if (payload.method) details.push({ label: labels.method, value: payload.method });
  if (payload.status) details.push({ label: labels.status, value: payload.status });
  if (payload.reasonCode) {
    const reasons = {
      NO_LONGER_NEEDED: { ht: 'Pa bezwen ankò', en: 'No longer needed', fr: 'Plus nécessaire', es: 'Ya no se necesita' },
      PAYMENT_METHOD_ISSUE: { ht: 'Pwoblèm metòd peman', en: 'Payment method issue', fr: 'Problème de méthode de paiement', es: 'Problema con el método de pago' },
      ORDER_DETAILS_INCORRECT: { ht: 'Enfòmasyon lòd la pa kòrèk', en: 'Incorrect order details', fr: 'Informations de commande incorrectes', es: 'Datos de orden incorrectos' },
      CANNOT_PAY_IN_TIME: { ht: 'Pa ka peye alè', en: 'Cannot pay in time', fr: 'Impossible de payer à temps', es: 'No puede pagar a tiempo' },
      OTHER: { ht: 'Lòt rezon', en: 'Other reason', fr: 'Autre motif', es: 'Otro motivo' }
    };
    details.push({ label: labels.reason, value: (reasons[payload.reasonCode] && reasons[payload.reasonCode][lang]) || payload.reasonCode });
  }
  if (payload.alertType) details.push({ label: labels.alert, value: payload.alertType });
  if (payload.event) details.push({ label: labels.event, value: payload.event });
  return noticeEmail({
    title: entry.title,
    summary,
    details,
    locale: lang,
    admin: role === 'ADMIN',
    occurredAt: payload.occurredAt || new Date().toISOString()
  });
}

module.exports = { escapeHtml, otpEmail, noticeEmail, notificationEmail };
