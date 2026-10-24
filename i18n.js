// Tradiksyon pataje: [Kreyòl, Français, English, Español]
// Tèks Kreyòl la ki nan paj yo (chak chèn ki matche ak 1ye kolòn nan) tradui otomatikman.
(function () {
  const T = {
    hello: ['Bonjou,', 'Bonjour,', 'Hello,', 'Hola,'],
    bannedMsg: ['Kont ou bani. Ou ka fè depo sèlman. Kontakte sipò a pou plis enfòmasyon.', 'Votre compte est banni. Vous ne pouvez faire que des dépôts. Contactez le support.', 'Your account is banned. You can only make deposits. Contact support for more information.', 'Tu cuenta está suspendida. Solo puedes hacer depósitos. Contacta a soporte.'],
    profileMsg: ['Konplete enfòmasyon pèsonèl ou nan Paramèt pou w ka fè swap ak retrè.', 'Complétez vos informations personnelles dans Paramètres pour faire des swaps et des retraits.', 'Complete your personal information in Settings to swap and withdraw.', 'Completa tu información personal en Ajustes para hacer swaps y retiros.'],
    goSettings: ['Ale nan Paramèt', 'Aller aux paramètres', 'Go to Settings', 'Ir a Ajustes'],
    balance: ['Balans disponib', 'Solde disponible', 'Available balance', 'Saldo disponible'],
    usdLabel: ['Dola (USD / USDT)', 'Dollars (USD / USDT)', 'Dollars (USD / USDT)', 'Dólares (USD / USDT)'],
    rateLabel: ['To chanj', 'Taux de change', 'Exchange rate', 'Tipo de cambio'],
    deposit: ['Depo', 'Dépôt', 'Deposit', 'Depósito'],
    withdraw: ['Retrè', 'Retrait', 'Withdraw', 'Retiro'],
    swap: ['Swap', 'Swap', 'Swap', 'Swap'],
    exchange: ['Echanj', 'Échange', 'Exchange', 'Cambio'],
    history: ['Istwa tranzaksyon', 'Historique des transactions', 'Transaction history', 'Historial de transacciones'],
    navHome: ['Akèy', 'Accueil', 'Home', 'Inicio'],
    navHistory: ['Istwa', 'Historique', 'History', 'Historial'],
    navSettings: ['Paramèt', 'Paramètres', 'Settings', 'Ajustes'],
    swapTitle: ['Swap HTG → dola', 'Swap HTG → dollars', 'Swap HTG → dollars', 'Swap HTG → dólares'],
    swapIntro: ['Chanje balans HTG ou an dola (USD/USDT). Apre sa ou ka retire l sou Meru, PayPal, Wise, Zelle, CashApp oswa USDT.', 'Convertissez votre solde HTG en dollars (USD/USDT). Vous pourrez ensuite retirer sur Meru, PayPal, Wise, Zelle, CashApp ou USDT.', 'Convert your HTG balance to dollars (USD/USDT). Then withdraw to Meru, PayPal, Wise, Zelle, CashApp or USDT.', 'Convierte tu saldo HTG a dólares (USD/USDT). Luego puedes retirar a Meru, PayPal, Wise, Zelle, CashApp o USDT.'],
    amtHtg: ['Montan an HTG', 'Montant en HTG', 'Amount in HTG', 'Monto en HTG'],
    amtUsd: ['Montan an dola', 'Montant en dollars', 'Amount in dollars', 'Monto en dólares'],
    maxBal: ['Tout balans', 'Tout le solde', 'Max balance', 'Todo el saldo'],
    whichMethod: ['Sou ki metòd ou pral retire?', 'Sur quelle méthode retirerez-vous ?', 'Which method will you withdraw to?', '¿A qué método retirarás?'],
    optional: ['(opsyonèl)', '(facultatif)', '(optional)', '(opcional)'],
    noSwapNeeded: ['Pou MonCash ak NatCash ou pa bezwen swap: retire dirèkteman an HTG.', 'Pour MonCash et NatCash, pas de swap : retirez directement en HTG.', 'For MonCash and NatCash no swap is needed: withdraw directly in HTG.', 'Para MonCash y NatCash no necesitas swap: retira directamente en HTG.'],
    rate: ['To', 'Taux', 'Rate', 'Tasa'],
    fee: ['Frè', 'Frais', 'Fee', 'Comisión'],
    feeWord: ['frè', 'frais', 'fee', 'comisión'],
    youReceive: ['Ou ap resevwa', 'Vous recevrez', 'You will receive', 'Recibirás'],
    confirmSwap: ['Konfime swap', 'Confirmer le swap', 'Confirm swap', 'Confirmar swap'],
    method: ['Metòd', 'Méthode', 'Method', 'Método'],
    amount: ['Montan', 'Montant', 'Amount', 'Monto'],
    destAcc: ['Kont destinasyon', 'Compte de destination', 'Destination account', 'Cuenta de destino'],
    confirmWd: ['Konfime retrè', 'Confirmer le retrait', 'Confirm withdrawal', 'Confirmar retiro'],
    pinLabel: ['PIN 6 chif', 'PIN à 6 chiffres', '6-digit PIN', 'PIN de 6 dígitos'],
    aNotif: ['Notifikasyon', 'Notifications', 'Notifications', 'Notificaciones'],
    search: ['Chèche pa metòd oswa montan', 'Rechercher par méthode ou montant', 'Search by method or amount', 'Buscar por método o monto'],
    close: ['Fèmen', 'Fermer', 'Close', 'Cerrar'],
    noNotif: ['Pa gen nouvo notifikasyon.', 'Aucune nouvelle notification.', 'No new notifications.', 'Sin notificaciones nuevas.'],
    soon: ['{n} pa disponib ankò. N ap ajoute l byento.', '{n} n’est pas encore disponible. Bientôt !', '{n} is not available yet. Coming soon.', '{n} aún no está disponible. Muy pronto.'],
    fAll: ['Tout', 'Tout', 'All', 'Todo'],
    st_pending: ['An kou', 'En cours', 'Pending', 'En curso'],
    st_done: ['Fini', 'Terminé', 'Completed', 'Completado'],
    st_failed: ['Echwe', 'Échoué', 'Failed', 'Fallido'],
    noTx: ['Pa gen tranzaksyon.', 'Aucune transaction.', 'No transactions.', 'Sin transacciones.'],
    txSwap: ['Swap HTG → USD', 'Swap HTG → USD', 'Swap HTG → USD', 'Swap HTG → USD'],
    txWd: ['Retrè · {m}', 'Retrait · {m}', 'Withdrawal · {m}', 'Retiro · {m}'],
    txAdjust: ['Ajisteman', 'Ajustement', 'Adjustment', 'Ajuste'],
    bannedToast: ['Kont ou bani. Ou ka fè depo sèlman.', 'Compte banni. Dépôts uniquement.', 'Account banned. Deposits only.', 'Cuenta suspendida. Solo depósitos.'],
    errZeroHtg: ['Balans HTG ou se 0.00. Ou pa ka fè swap pou kounye a.', 'Votre solde HTG est de 0,00. Swap impossible.', 'Your HTG balance is 0.00. You cannot swap right now.', 'Tu saldo HTG es 0.00. No puedes hacer swap ahora.'],
    errAmt: ['Antre yon montan valid.', 'Entrez un montant valide.', 'Enter a valid amount.', 'Ingresa un monto válido.'],
    errBalHtg: ['Balans HTG ou pa sifi.', 'Solde HTG insuffisant.', 'Insufficient HTG balance.', 'Saldo HTG insuficiente.'],
    errBal: ['Balans ou pa sifi.', 'Solde insuffisant.', 'Insufficient balance.', 'Saldo insuficiente.'],
    errSmall: ['Montan an twò piti pou yon swap.', 'Montant trop petit pour un swap.', 'Amount too small for a swap.', 'Monto muy pequeño para un swap.'],
    swapDone: ['Swap fèt! Dola a nan balans ou.', 'Swap effectué ! Les dollars sont dans votre solde.', 'Swap done! The dollars are in your balance.', '¡Swap hecho! Los dólares están en tu saldo.'],
    swapDoneWd: ['Swap fèt! Kounye a fini retrè a sou {m}.', 'Swap effectué ! Terminez maintenant le retrait sur {m}.', 'Swap done! Now complete the withdrawal to {m}.', '¡Swap hecho! Ahora completa el retiro a {m}.'],
    errNoBal: ['Ou pa gen balans pou retire.', 'Aucun solde à retirer.', 'You have no balance to withdraw.', 'No tienes saldo para retirar.'],
    hintHtg: ['Balans HTG ka retire sèlman sou MonCash ak NatCash. Pou Meru, Zelle, USDT, CashApp, PayPal, Wise, swap an dola dabò.', 'Le solde HTG ne peut être retiré que sur MonCash et NatCash. Pour Meru, Zelle, USDT, CashApp, PayPal, Wise, faites d’abord un swap en dollars.', 'HTG balance can only be withdrawn to MonCash and NatCash. For Meru, Zelle, USDT, CashApp, PayPal, Wise, swap to dollars first.', 'El saldo HTG solo se retira a MonCash y NatCash. Para Meru, Zelle, USDT, CashApp, PayPal, Wise, haz swap a dólares primero.'],
    hintUsd: ['Retire dola ou sou Meru, Zelle, USDT, CashApp, PayPal oswa Wise.', 'Retirez vos dollars sur Meru, Zelle, USDT, CashApp, PayPal ou Wise.', 'Withdraw your dollars to Meru, Zelle, USDT, CashApp, PayPal or Wise.', 'Retira tus dólares a Meru, Zelle, USDT, CashApp, PayPal o Wise.'],
    pickFirst: ['Chwazi yon metòd dabò', 'Choisissez d’abord une méthode', 'Choose a method first', 'Elige un método primero'],
    errMethod: ['Chwazi yon metòd.', 'Choisissez une méthode.', 'Choose a method.', 'Elige un método.'],
    errAcc: ['Antre kont destinasyon an.', 'Entrez le compte de destination.', 'Enter the destination account.', 'Ingresa la cuenta de destino.'],
    errPin: ['Antre PIN 6 chif ou.', 'Entrez votre PIN à 6 chiffres.', 'Enter your 6-digit PIN.', 'Ingresa tu PIN de 6 dígitos.'],
    wdSent: ['Demann retrè a voye. Ekip nou ap trete l.', 'Demande de retrait envoyée. Notre équipe la traite.', 'Withdrawal request sent. Our team is processing it.', 'Solicitud de retiro enviada. Nuestro equipo la procesa.'],
    errGen: ['Erè. Eseye ankò.', 'Erreur. Réessayez.', 'Error. Try again.', 'Error. Inténtalo de nuevo.'],
    cGoud: ['Goud', 'Gourdes', 'Gourdes', 'Gourdes'],
    cDola: ['Dola', 'Dollars', 'Dollars', 'Dólares'],
    accPhone: ['Nimewo {m}', 'Numéro {m}', '{m} number', 'Número de {m}'],
    accAcc: ['Kont {m}', 'Compte {m}', '{m} account', 'Cuenta {m}'],
    accWallet: ['Adrès wallet {m}', 'Adresse wallet {m}', '{m} wallet address', 'Dirección de wallet {m}'],
    accZelle: ['Imèl oswa telefòn Zelle', 'E-mail ou téléphone Zelle', 'Zelle email or phone', 'Correo o teléfono de Zelle'],
    accCash: ['$Cashtag CashApp', '$Cashtag CashApp', '$Cashtag CashApp', '$Cashtag CashApp'],
    accMail: ['Imèl {m}', 'E-mail {m}', '{m} email', 'Correo de {m}'],
    // ----- Paramèt -----
    back: ['Retounen', 'Retour', 'Back', 'Volver'],
    yourId: ['Idantifyan ou', 'Votre identifiant', 'Your ID', 'Tu ID'],
    copy: ['Kopye', 'Copier', 'Copy', 'Copiar'],
    copied: ['Kopye!', 'Copié !', 'Copied!', '¡Copiado!'],
    language: ['Lang', 'Langue', 'Language', 'Idioma'],
    personal: ['Enfòmasyon pèsonèl', 'Informations personnelles', 'Personal information', 'Información personal'],
    firstName: ['Non', 'Prénom', 'First name', 'Nombre'],
    lastName: ['Siyati', 'Nom de famille', 'Last name', 'Apellido'],
    dob: ['Dat nesans', 'Date de naissance', 'Date of birth', 'Fecha de nacimiento'],
    country: ['Peyi', 'Pays', 'Country', 'País'],
    chooseCountry: ['Chwazi peyi a', 'Choisir le pays', 'Select country', 'Elegir país'],
    phone: ['Nimewo telefòn', 'Numéro de téléphone', 'Phone number', 'Número de teléfono'],
    address: ['Adrès (ri, vil, kòd postal)', 'Adresse (rue, ville, code postal)', 'Address (street, city, postal code)', 'Dirección (calle, ciudad, código postal)'],
    reqNote: ['Tout chan yo obligatwa. Apre w anrejistre yo, ou pa ka chanje yo ankò.', 'Tous les champs sont obligatoires. Une fois enregistrés, ils ne peuvent plus être modifiés.', 'All fields are required. Once saved, they cannot be changed.', 'Todos los campos son obligatorios. Una vez guardados, no se pueden cambiar.'],
    lockedNote: ['Enfòmasyon sa yo anrejistre epi yo pa ka chanje.', 'Ces informations sont enregistrées et ne peuvent pas être modifiées.', 'This information is saved and cannot be changed.', 'Esta información está guardada y no se puede cambiar.'],
    saveProfile: ['Anrejistre enfòmasyon yo', 'Enregistrer les informations', 'Save information', 'Guardar información'],
    confirmLock: ['Apre w anrejistre, ou pa ka chanje enfòmasyon sa yo ankò. Kontinye?', 'Après enregistrement, vous ne pourrez plus modifier ces informations. Continuer ?', 'After saving you will not be able to change this information. Continue?', 'Después de guardar no podrás cambiar esta información. ¿Continuar?'],
    profileSaved: ['Enfòmasyon yo anrejistre.', 'Informations enregistrées.', 'Information saved.', 'Información guardada.'],
    errFields: ['Ranpli tout chan yo.', 'Remplissez tous les champs.', 'Fill in all fields.', 'Completa todos los campos.'],
    security: ['Sekirite', 'Sécurité', 'Security', 'Seguridad'],
    pinDesc: ['Lè PIN lan aktif, ou ka konekte ak PIN lan olye de mòdpas ou, epi chak retrè ap mande PIN lan.', 'Quand le PIN est actif, vous pouvez vous connecter avec le PIN au lieu du mot de passe, et chaque retrait demande le PIN.', 'When the PIN is active you can sign in with the PIN instead of your password, and every withdrawal asks for the PIN.', 'Con el PIN activo puedes iniciar sesión con el PIN en lugar de la contraseña, y cada retiro pide el PIN.'],
    pinNew: ['Nouvo PIN', 'Nouveau PIN', 'New PIN', 'Nuevo PIN'],
    pinConfirm: ['Konfime PIN lan', 'Confirmez le PIN', 'Confirm PIN', 'Confirmar PIN'],
    curPass: ['Mòdpas ou kounye a', 'Mot de passe actuel', 'Current password', 'Contraseña actual'],
    activate: ['Aktive PIN lan', 'Activer le PIN', 'Activate PIN', 'Activar PIN'],
    deactivate: ['Dezaktive PIN lan', 'Désactiver le PIN', 'Deactivate PIN', 'Desactivar PIN'],
    pinOn: ['PIN aktif', 'PIN actif', 'PIN active', 'PIN activo'],
    pinOff: ['PIN pa aktif', 'PIN inactif', 'PIN not active', 'PIN inactivo'],
    pinMismatch: ['PIN yo pa menm.', 'Les PIN ne correspondent pas.', 'PINs do not match.', 'Los PIN no coinciden.'],
    pinOk: ['PIN aktive.', 'PIN activé.', 'PIN activated.', 'PIN activado.'],
    pinOffOk: ['PIN dezaktive.', 'PIN désactivé.', 'PIN deactivated.', 'PIN desactivado.'],
    invite: ['Envite lòt moun', 'Inviter des personnes', 'Invite people', 'Invitar personas'],
    inviteDesc: ['Pataje lyen ou a. Moun ki enskri ak li yo konte nan envitasyon ou yo.', 'Partagez votre lien. Les personnes qui s’inscrivent avec comptent dans vos invitations.', 'Share your link. People who sign up with it count as your invitations.', 'Comparte tu enlace. Las personas que se registran con él cuentan como tus invitaciones.'],
    copyLink: ['Kopye lyen an', 'Copier le lien', 'Copy link', 'Copiar enlace'],
    share: ['Pataje', 'Partager', 'Share', 'Compartir'],
    invited: ['{n} moun envite', '{n} personne(s) invitée(s)', '{n} people invited', '{n} persona(s) invitada(s)'],
    kycStatus: ['Verifikasyon idantite', 'Vérification d’identité', 'Identity verification', 'Verificación de identidad'],
    verified: ['Verifye', 'Vérifié', 'Verified', 'Verificado'],
    notVerified: ['Pa verifye', 'Non vérifié', 'Not verified', 'No verificado'],
    logout: ['Dekonekte', 'Se déconnecter', 'Log out', 'Cerrar sesión']
  };
  const IDX = { ht: 0, fr: 1, en: 2, es: 3 };
  const REV = {};
  for (const k in T) if (!(T[k][0] in REV)) REV[T[k][0]] = k;

  window.LANG = localStorage.getItem('lang') || 'ht';
  window.t = (k, v) => {
    const a = T[k];
    if (!a) return k;
    let s = a[IDX[window.LANG]] || a[0];
    if (v) for (const x in v) s = s.split('{' + x + '}').join(v[x]);
    return s;
  };
  window.applyI18n = () => {
    document.documentElement.lang = window.LANG;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      if (n.parentNode.closest('script,style')) continue;
      const k = n._k || REV[n.nodeValue.trim()];
      if (k) { n._k = k; const cur = n.nodeValue.trim(); n.nodeValue = n.nodeValue.replace(cur, () => window.t(k)); }
    }
    document.querySelectorAll('[placeholder],[aria-label]').forEach((el) => {
      ['placeholder', 'aria-label'].forEach((a) => {
        if (!el.hasAttribute(a)) return;
        const key = el['_k' + a] || REV[el.getAttribute(a)];
        if (key) { el['_k' + a] = key; el.setAttribute(a, window.t(key)); }
      });
    });
  };
  window.setLang = (l) => { if (!(l in IDX)) l = 'ht'; window.LANG = l; localStorage.setItem('lang', l); window.applyI18n(); };
  document.addEventListener('DOMContentLoaded', window.applyI18n);
})();
