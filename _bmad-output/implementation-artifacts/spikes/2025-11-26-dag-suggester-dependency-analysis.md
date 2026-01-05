# Spike: Analyse Critique de la Logique de Dépendance du DAG Suggester

**Date:** 2025-11-26 **Auteur:** Cascade (AI Assistant) **Contexte:** Analyse du fichier
`src/graphrag/graph-engine.ts`, méthode `buildDAG`.

## 1. L'Implémentation Actuelle

Le système utilise une approche "gloutonne" basée sur l'ordre de la liste des candidats fournie par
la recherche vectorielle.

```typescript
// Pseudo-code de la logique actuelle
buildDAG(candidates):
  Pour chaque outil B (index i):
    Pour chaque outil A (index j < i):
      Si chemin(A -> B) existe ET longueur <= 4:
        B dépend de A
```

### Les critères de dépendance

1. **Antériorité dans la liste** : `j < i` (condition stricte).
2. **Existence d'un chemin** : Le graphe doit contenir une trace historique.
3. **Proximité** : Le chemin doit faire 3 sauts ou moins (<= 4 nœuds).

## 2. Analyse des Faiblesses Identifiées

### A. Le Biais d'Ordonnancement (Critical)

L'algorithme suppose implicitement que les **prérequis** (parents) ont un meilleur score sémantique
ou PageRank que leurs **dépendances** (enfants), et apparaissent donc avant eux dans la liste
`candidateTools`.

**Scénario de défaillance :** Si la recherche vectorielle retourne : `[Enfant, Parent]`

1. L'algo traite `Enfant`. Il n'y a personne avant lui. -> **Aucune dépendance.**
2. L'algo traite `Parent`. Il compare avec `Enfant`. Le sens `Enfant -> Parent` n'existe pas dans le
   graphe. -> **Aucune dépendance.**

**Résultat** : Les deux tâches démarrent en parallèle. La tâche `Enfant` échouera car son prérequis
n'est pas prêt.

### B. Le "Chiffre Magique" (<= 4)

Le seuil de 4 nœuds (3 sauts) est arbitraire.

- **Risque de Faux Positifs** : Un lien faible (A -> X -> Y -> B) peut créer une dépendance
  bloquante inutile, réduisant le parallélisme.
- **Risque de Faux Négatifs** : Une dépendance réelle mais distante (via des outils intermédiaires
  non présents dans la sélection) pourrait être ignorée si elle dépasse 4 nœuds.

## 3. Recommandations d'Amélioration

Pour passer d'un MVP à une solution robuste ("Production Grade"), nous recommandons l'évolution
suivante :

### Solution : Matrice Complète + Tri Topologique

Ne plus dépendre de l'ordre d'entrée de la liste.

**Algorithme Proposé :**

1. **Construction de la Matrice** Comparer chaque outil candidat avec **tous les autres** (N\*N
   comparaisons), peu importe leur ordre dans la liste.

2. **Identification des Arcs Orientés** Pour chaque paire (A, B) :

   - Si `Graph.hasPath(A -> B)` est fort : Ajouter arc A->B.
   - Si `Graph.hasPath(B -> A)` est fort : Ajouter arc B->A.

3. **Détection de Cycles** Si A->B et B->A existent tous les deux (cas rare mais possible dans un
   graphe d'usage), utiliser le PageRank ou le score sémantique pour trancher le sens prioritaire.

4. **Construction du DAG** Utiliser ces arcs validés pour construire la liste des tâches. L'ordre
   dans le tableau `tasks` final importe peu pour l'exécuteur, tant que le champ `depends_on` est
   correct.

### Exemple de correction

_Entrée :_ `[Analyse(B), Génération(A)]`

**Actuel :**

- Analyse : Pas de prédecesseur.
- Génération : Pas de lien vers Analyse. -> Parallèle (Echec).

**Proposé :**

- Test A->B : "Génération -> Analyse" existe ? **OUI**.
- Test B->A : "Analyse -> Génération" existe ? **NON**. -> Ajout contrainte :
  `Analyse.depends_on = [Génération]`. -> Succès.

## 4. Conclusion

L'implémentation actuelle est un excellent "Fast Fail" pattern qui favorise le parallélisme par
défaut. Cependant, elle est vulnérable au classement de la recherche vectorielle. L'adoption d'une
approche par matrice d'adjacence complète est recommandée pour la prochaine itération de robustesse.
